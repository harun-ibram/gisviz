"""
Shared infrastructure: R2 (Cloudflare) object storage + the Cloud SQL engine.

Extracted verbatim from main.py so gis_api / gis_worker can reach the bucket and
the database without importing main — which imports the router, and would be a
circular import.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Annotated

import boto3
import pg8000
import sqlalchemy
from botocore.config import Config
from fastapi import Depends
from google.cloud.sql.connector import Connector, IPTypes
from google.oauth2 import service_account
from sqlmodel import Session

# ---------------------------------------------------------------------------
# Cloudflare R2
# ---------------------------------------------------------------------------
r2_client = boto3.client(
    "s3",
    endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    config=Config(signature_version="s3v4"),
    region_name="auto",
)

BUCKET = os.environ["R2_BUCKET_NAME"]


def get_signed_url(
    path: str, expires_in: int = 3600, download_as: str | None = None
) -> str:
    """
    Presigned GET URL for an object.

    `download_as` overrides the response's Content-Disposition so the browser
    saves the object under that name instead of trying to display it. It has to
    be signed in — the header is part of the signature, so a client cannot bolt
    it onto a plain URL afterwards, and the `download` attribute on an anchor is
    ignored cross-origin. Without it a viewer downloading a splat would get
    whatever filename R2 infers from the key, or an inline render.
    """
    params: dict[str, str] = {"Bucket": BUCKET, "Key": path}
    if download_as:
        # Quotes escaped rather than the name rejected: an odd filename is not
        # worth failing a download over, and an unescaped `"` would truncate
        # the header value.
        safe = download_as.replace("\\", "").replace('"', "")
        params["ResponseContentDisposition"] = f'attachment; filename="{safe}"'
    return r2_client.generate_presigned_url(
        "get_object",
        Params=params,
        ExpiresIn=expires_in,
    )


def get_upload_url(path: str, expires_in: int = 3600) -> str:
    """Presigned PUT URL so a client can upload a file straight to R2."""
    return r2_client.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET, "Key": path},
        ExpiresIn=expires_in,
    )


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
def get_gcp_credentials():
    b64 = os.environ["GOOGLE_CREDENTIALS_B64"]
    info = json.loads(base64.b64decode(b64))
    return service_account.Credentials.from_service_account_info(info)


def connect_with_connector() -> sqlalchemy.engine.base.Engine:
    """
    Initializes a connection pool for a Cloud SQL instance of Postgres.

    Uses the Cloud SQL Python Connector package.
    """
    # Note: Saving credentials in environment variables is convenient, but not
    # secure - consider a more secure solution such as
    # Cloud Secret Manager (https://cloud.google.com/secret-manager) to help
    # keep secrets safe.

    instance_connection_name = os.environ[
        "INSTANCE_CONNECTION_NAME"
    ]  # e.g. 'project:region:instance'
    db_user = os.environ["DB_USER"]  # e.g. 'my-db-user'
    db_pass = os.environ["DB_PASSWORD"]  # e.g. 'my-db-password'
    db_name = os.environ["DB_NAME"]  # e.g. 'my-database'

    ip_type = IPTypes.PRIVATE if os.environ.get("PRIVATE_IP") else IPTypes.PUBLIC

    # initialize Cloud SQL Python Connector object
    connector = Connector(
        refresh_strategy="LAZY",
        credentials=get_gcp_credentials(),
    )

    def getconn() -> pg8000.dbapi.Connection:
        conn: pg8000.dbapi.Connection = connector.connect(
            instance_connection_name,
            "pg8000",
            user=db_user,
            password=db_pass,
            db=db_name,
            ip_type=ip_type,
        )
        return conn

    # The Cloud SQL Python Connector can be used with SQLAlchemy
    # using the 'creator' argument to 'create_engine'.
    #
    # pool_pre_ping / pool_recycle matter now that GIS jobs run in a background
    # thread: a job can leave a pooled connection idle for 10+ minutes while it
    # processes, and Cloud SQL drops connections well before SQLAlchemy notices.
    pool = sqlalchemy.create_engine(
        "postgresql+pg8000://",
        creator=getconn,
        pool_pre_ping=True,
        pool_recycle=1800,
        pool_size=5,
        max_overflow=5,
    )
    return pool


# Create the engine once at module load / startup, not per-request
engine = connect_with_connector()


def get_session():
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]
