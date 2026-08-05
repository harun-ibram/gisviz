"""
Login core: users table, password hashing, JWTs, and the route guard.

No router lives here on purpose — gis_api imports RequireUser from this module,
and main imports both, so keeping the router in auth_api keeps that a straight
line rather than a cycle (the same split as gis_runtime / gis_schema / gis_api).

Everything talks to the database through raw text() SQL against deps.engine,
like gis_api does; there is no SQLModel for users in models.py.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Annotated, Any

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy import text

from deps import SessionDep

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# Deliberately not os.environ[...] the way deps.py reads its Cloud SQL settings:
# a missing auth secret must not stop the public viewing API from booting. It
# fails *closed* instead — login returns 503 and every protected route 401 —
# so the absence of a secret can never be mistaken for "auth is off".
AUTH_SECRET: str | None = os.environ.get("AUTH_SECRET") or None
AUTH_ALGORITHM = "HS256"

try:
    AUTH_TOKEN_TTL = int(os.environ.get("AUTH_TOKEN_TTL", "28800"))  # 8h
except ValueError:
    logger.warning("AUTH_TOKEN_TTL is not an integer; falling back to 28800")
    AUTH_TOKEN_TTL = 28800

if not AUTH_SECRET:
    logger.warning(
        "AUTH_SECRET is not set: nobody can log in and every upload route will "
        "return 401. Set it to a long random string to enable logins."
    )

# bcrypt hashes at most the first 72 bytes of a password and silently ignores
# the rest, so a longer one is rejected at the call site rather than quietly
# truncated into a weaker credential.
MAX_PASSWORD_BYTES = 72

# Compared against when the email is unknown, so a login attempt burns the same
# bcrypt work either way and response time does not leak whether an account
# exists. Hash of a value no user can have: bcrypt of 64 random bytes.
_DUMMY_HASH = "$2b$12$NZHLvmw2SEQw9qI/qzffeO70Asu1XK50hXakjjn07qIvAsUEYY0Hm"


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
# One statement per entry, the same shape as gis_schema.DDL_STATEMENTS: pg8000's
# extended query protocol cannot run several ';'-separated statements in a call.
AUTH_DDL: list[str] = [
    """
    CREATE TABLE IF NOT EXISTS public.users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
]


def ensure_auth_schema(engine) -> None:
    """Apply AUTH_DDL one statement per transaction (see ensure_gis_schema)."""
    applied = 0
    for statement in AUTH_DDL:
        sql = statement.strip()
        try:
            with engine.begin() as conn:
                conn.execute(text(sql))
            applied += 1
        except Exception:
            logger.warning("Auth schema statement failed: %s", sql.split("\n")[0][:120], exc_info=True)
    logger.info("Auth schema: %d/%d statements applied", applied, len(AUTH_DDL))


# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    encoded = password.encode("utf-8")
    if len(encoded) > MAX_PASSWORD_BYTES:
        raise ValueError(f"Password must be at most {MAX_PASSWORD_BYTES} bytes")
    return bcrypt.hashpw(encoded, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    encoded = password.encode("utf-8")
    if len(encoded) > MAX_PASSWORD_BYTES:
        return False
    try:
        return bcrypt.checkpw(encoded, password_hash.encode("utf-8"))
    except ValueError:
        # Malformed hash in the row — treat as a failed login, not a 500.
        return False


def burn_password_check(password: str) -> None:
    """Spend the same bcrypt time on an unknown email as on a real one."""
    verify_password(password, _DUMMY_HASH)


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------
class AuthUser(BaseModel):
    id: str
    email: str


def create_access_token(user: AuthUser) -> str:
    """Sign a bearer token for `user`. Raises RuntimeError if auth is disabled."""
    if not AUTH_SECRET:
        raise RuntimeError("AUTH_SECRET is not configured")
    now = int(time.time())
    claims = {
        "sub": user.id,
        "email": user.email,
        "iat": now,
        "exp": now + AUTH_TOKEN_TTL,
    }
    return jwt.encode(claims, AUTH_SECRET, algorithm=AUTH_ALGORITHM)


def decode_token(token: str) -> dict[str, Any] | None:
    """Claims of a valid, unexpired token; None for anything else."""
    if not AUTH_SECRET:
        return None
    try:
        return jwt.decode(token, AUTH_SECRET, algorithms=[AUTH_ALGORITHM])
    except jwt.PyJWTError:
        return None


# ---------------------------------------------------------------------------
# Brute-force brake
# ---------------------------------------------------------------------------
# Per-process and in-memory: one Railway instance runs this API, so a dict is
# enough. It resets on every redeploy and would not be shared if the service
# were ever scaled out — at which point this belongs in the database or Redis.
LOGIN_MAX_FAILURES = 5
LOGIN_FAILURE_WINDOW = 900  # 15 minutes

_login_failures: dict[str, tuple[int, float]] = {}


def login_is_throttled(email: str) -> bool:
    entry = _login_failures.get(email)
    if not entry:
        return False
    count, first_failure = entry
    if time.time() - first_failure > LOGIN_FAILURE_WINDOW:
        _login_failures.pop(email, None)
        return False
    return count >= LOGIN_MAX_FAILURES


def record_login_failure(email: str) -> None:
    now = time.time()
    count, first_failure = _login_failures.get(email, (0, now))
    if now - first_failure > LOGIN_FAILURE_WINDOW:
        count, first_failure = 0, now
    _login_failures[email] = (count + 1, first_failure)


def clear_login_failures(email: str) -> None:
    _login_failures.pop(email, None)


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------
def normalize_email(email: str) -> str:
    return email.strip().lower()


def new_user_id() -> str:
    return str(uuid.uuid4())


def get_user_by_email(session, email: str) -> dict[str, Any] | None:
    return session.execute(
        text("SELECT id, email, password_hash, is_active FROM public.users WHERE email = :email"),
        {"email": normalize_email(email)},
    ).mappings().first()


def get_active_user_by_id(session, user_id: str) -> dict[str, Any] | None:
    return session.execute(
        text("SELECT id, email FROM public.users WHERE id = :id AND is_active"),
        {"id": user_id},
    ).mappings().first()


# ---------------------------------------------------------------------------
# Route guard
# ---------------------------------------------------------------------------
# auto_error=False so a missing header produces our own 401 with a consistent
# body, rather than FastAPI's 403 "Not authenticated".
_bearer = HTTPBearer(auto_error=False)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"}
    )


async def get_current_user(
    request: Request,
    session: SessionDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)] = None,
) -> AuthUser:
    """Resolve the bearer token to a live, active user, or raise 401."""
    if not AUTH_SECRET:
        raise _unauthorized("Authentication is not configured on this server")
    if credentials is None or not credentials.credentials:
        raise _unauthorized("Not authenticated")

    claims = decode_token(credentials.credentials)
    if not claims or not claims.get("sub"):
        raise _unauthorized("Invalid or expired token")

    # The row is re-read on every request so deactivating an account takes
    # effect immediately instead of when the last issued token expires.
    row = get_active_user_by_id(session, str(claims["sub"]))
    if row is None:
        raise _unauthorized("Invalid or expired token")

    user = AuthUser(id=row["id"], email=row["email"])
    request.state.user = user
    return user


RequireUser = Depends(get_current_user)
