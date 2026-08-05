"""
The /auth HTTP surface: log in, and tell the client who it is.

There is no logout route — the tokens are stateless JWTs, so logging out is the
client dropping the token. There is no signup route either: accounts are made
with src/create_user.py against the database.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from auth import (
    AUTH_SECRET,
    AUTH_TOKEN_TTL,
    AuthUser,
    RequireUser,
    burn_password_check,
    clear_login_failures,
    create_access_token,
    get_user_by_email,
    login_is_throttled,
    normalize_email,
    record_login_failure,
    verify_password,
)
from deps import SessionDep

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# One message for "no such user" and for "wrong password" alike: telling them
# apart is a free account-enumeration oracle.
_INVALID_CREDENTIALS = "Invalid email or password"


class LoginRequest(BaseModel):
    email: str
    password: str


@router.post("/login")
async def login(body: LoginRequest, session: SessionDep) -> dict:
    if not AUTH_SECRET:
        raise HTTPException(
            status_code=503, detail="Authentication is not configured on this server"
        )

    email = normalize_email(body.email)
    if login_is_throttled(email):
        raise HTTPException(
            status_code=429, detail="Too many failed attempts. Try again in a few minutes."
        )

    row = get_user_by_email(session, email)
    if row is None or not row["is_active"]:
        # Same bcrypt cost as a real check, so response time says nothing about
        # whether the account exists.
        burn_password_check(body.password)
        record_login_failure(email)
        raise HTTPException(status_code=401, detail=_INVALID_CREDENTIALS)

    if not verify_password(body.password, row["password_hash"]):
        record_login_failure(email)
        raise HTTPException(status_code=401, detail=_INVALID_CREDENTIALS)

    clear_login_failures(email)
    user = AuthUser(id=row["id"], email=row["email"])
    return {
        "access_token": create_access_token(user),
        "token_type": "bearer",
        "expires_in": AUTH_TOKEN_TTL,
        "user": {"id": user.id, "email": user.email},
    }


@router.get("/me")
async def me(user: AuthUser = RequireUser) -> dict:
    """Used by the frontend to decide whether to show the upload UI, and to
    notice a token that has expired since it was stored."""
    return {"id": user.id, "email": user.email}
