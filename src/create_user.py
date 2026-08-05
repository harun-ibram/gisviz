"""
Create (or reset the password of) a login account.

    python src/create_user.py you@example.com
    python src/create_user.py you@example.com --password 'hunter2'
    python src/create_user.py you@example.com --deactivate

There is no signup endpoint, so this script is the only way an account comes
into existence. Re-running it on an existing email resets that account's
password, which makes it the password-reset tool as well.

Environment: this imports deps, which builds the Cloud SQL engine *and* the R2
client at import time, so it needs the full backend env — INSTANCE_CONNECTION_NAME,
DB_USER, DB_PASSWORD, DB_NAME, GOOGLE_CREDENTIALS_B64, R2_ACCOUNT_ID,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME. AUTH_SECRET is *not*
needed here — it only signs tokens at login time — so the "AUTH_SECRET is not
set" warning importing auth may print is expected and does not affect this
script's work.
"""

from __future__ import annotations

import argparse
import getpass
import sys

from sqlalchemy import text

from auth import (
    MAX_PASSWORD_BYTES,
    ensure_auth_schema,
    hash_password,
    new_user_id,
    normalize_email,
)
from deps import engine


def _prompt_password() -> str:
    """Ask twice, via getpass, so the password never reaches shell history."""
    first = getpass.getpass("Password: ")
    if not first:
        sys.exit("Password must not be empty")
    if first != getpass.getpass("Repeat password: "):
        sys.exit("Passwords do not match")
    return first


def set_active(email: str, active: bool) -> None:
    with engine.begin() as conn:
        result = conn.execute(
            text("UPDATE public.users SET is_active = :active WHERE email = :email"),
            {"active": active, "email": email},
        )
    if not result.rowcount:
        sys.exit(f"No such user: {email}")
    print(f"{email}: is_active = {active}")


def upsert_user(email: str, password: str) -> None:
    password_hash = hash_password(password)
    with engine.begin() as conn:
        row = conn.execute(
            text(
                """
                INSERT INTO public.users (id, email, password_hash)
                VALUES (:id, :email, :password_hash)
                ON CONFLICT (email) DO UPDATE
                    SET password_hash = EXCLUDED.password_hash,
                        is_active     = TRUE
                RETURNING id, (xmax = 0) AS created
                """
            ),
            {"id": new_user_id(), "email": email, "password_hash": password_hash},
        ).mappings().one()
    action = "Created" if row["created"] else "Updated password for"
    print(f"{action} {email} (id {row['id']})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1].strip())
    parser.add_argument("email")
    parser.add_argument(
        "--password",
        help="Password. Omit to be prompted, which keeps it out of shell history.",
    )
    parser.add_argument(
        "--deactivate",
        action="store_true",
        help="Deny this account's logins and invalidate its issued tokens.",
    )
    parser.add_argument(
        "--activate", action="store_true", help="Undo --deactivate."
    )
    args = parser.parse_args()

    email = normalize_email(args.email)
    if "@" not in email:
        sys.exit(f"Not an email address: {args.email}")

    ensure_auth_schema(engine)

    if args.deactivate or args.activate:
        if args.deactivate and args.activate:
            sys.exit("Pass at most one of --deactivate / --activate")
        set_active(email, active=args.activate)
        return

    password = args.password or _prompt_password()
    if len(password.encode("utf-8")) > MAX_PASSWORD_BYTES:
        # bcrypt hashes only the first 72 bytes; a longer password would be
        # silently truncated into a weaker one.
        sys.exit(f"Password must be at most {MAX_PASSWORD_BYTES} bytes")
    upsert_user(email, password)


if __name__ == "__main__":
    main()
