import json
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy import func, text
from sqlmodel import Session, SQLModel, select

from models import (
    Job,
    OSMNode,
    OSMRelation,
    OSMRelationMember,
    OSMWay,
    OSMWayNode,
    Region,
)

import os



from google.cloud.sql.connector import Connector, IPTypes
import pg8000

import sqlalchemy

import base64
import json
from google.oauth2 import service_account
import boto3
from botocore.config import Config


r2_client = boto3.client(
    "s3",
    endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    config=Config(signature_version="s3v4"),
    region_name="auto",
)

def get_signed_url(path: str) -> str:
    return r2_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": os.environ["R2_BUCKET_NAME"], "Key": path},
        ExpiresIn=3600
)


def get_upload_url(path: str) -> str:
    """Presigned PUT URL so a client can upload a photo straight to R2."""
    return r2_client.generate_presigned_url(
        "put_object",
        Params={"Bucket": os.environ["R2_BUCKET_NAME"], "Key": path},
        ExpiresIn=3600,
    )



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
    # using the 'creator' argument to 'create_engine'
    pool = sqlalchemy.create_engine(
        "postgresql+pg8000://",
        creator=getconn,
        # ...
    )
    return pool

# Create the engine once at module load / startup, not per-request
engine = connect_with_connector()

def get_session():
    with Session(engine) as session:
        yield session

SessionDep = Annotated[Session, Depends(get_session)]


# FastAPI and middleware
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "https://gisviz.vercel.app"],
    allow_methods=["*"],
    allow_headers=["*"]
)


# Helper function for formatting the data in the table into a usable object
def _row_to_dict(obj: SQLModel, geojson: str | None) -> dict[str, Any]:
    data = obj.model_dump(exclude="geom")
    data["geom"] = json.loads(geojson) if geojson else None
    return data



@app.get("/splat-url")
async def get_splat_url(path: str = Query(...)):
    return {"url": get_signed_url(path), "filename": path.split("/")[-1]}

# API endpoints
@app.get("/nodes")
async def get_nodes(session: SessionDep):
    rows = session.exec(
        select(OSMNode, func.ST_AsGeoJSON(OSMNode.geom))
    ).all()

    return [_row_to_dict(obj, geojson) for obj, geojson in rows]

@app.get("/splat_nodes")
async def get_splat_nodes(session: SessionDep):
    rows = session.exec(
        select(OSMNode, func.ST_AsGeoJSON(OSMNode.geom))
        .where(OSMNode.model_path != None)
    ).all()

    return [_row_to_dict(obj, geojson) for obj, geojson in rows]

@app.get("/nodes/{node_id}")
async def get_node(node_id: int, session: SessionDep):
    row = session.exec(
        select(OSMNode, func.ST_AsGeoJSON(OSMNode.geom))
        .where(OSMNode.node_id == node_id)
    ).first()

    if not row:
        return {"error": "Node not found"}
    
    obj, geojson = row

    return _row_to_dict(obj, geojson)

@app.get("/nodes/{node_id}/model_path")
async def get_node_model_path(node_id: int, session: SessionDep):
    node = session.exec(
        select(OSMNode)
        .where(OSMNode.node_id == node_id)
    ).first()

    if not node or not node.model_path:
        return {"error": "Node not found"}

    return {
        "model_path": node.model_path,
        "url": get_signed_url(node.model_path),
        "filename": node.model_path.split("/")[-1],
    }
    
class CreateNodeRequest(BaseModel):
    name: str
    lat: float
    lon: float


@app.post("/nodes")
async def create_node(body: CreateNodeRequest, session: SessionDep):
    """Create a bare node (point + name tag) to attach a splat to later."""
    row = session.exec(
        text(
            """
            INSERT INTO osm.nodes (node_id, geom, tags)
            VALUES (
                (SELECT COALESCE(MIN(node_id), 0) - 1 FROM osm.nodes),
                ST_SetSRID(ST_MakePoint(:lon, :lat), 4326),
                CAST(:tags AS jsonb)
            )
            RETURNING node_id
            """
        ),
        params={"lon": body.lon, "lat": body.lat, "tags": json.dumps({"name": body.name})},
    ).first()
    session.commit()
    return {"node_id": row[0]}


class CreateRegionRequest(BaseModel):
    name: str


@app.post("/regions")
async def create_region(body: CreateRegionRequest, session: SessionDep):
    """Create a bare region (name only, no boundary yet) to attach a splat to later."""
    region = Region(id=str(uuid.uuid4()), name=body.name, geom=None)
    session.add(region)
    session.commit()
    return {"id": region.id, "name": region.name}


@app.get("/regions")
async def get_regions(session: SessionDep):
    rows = session.exec(
        select(Region, func.ST_AsGeoJSON(Region.geom))
    ).all()

    return [_row_to_dict(obj, geojson) for obj, geojson in rows]

@app.get("/splat_regions")
async def get_splat_regions(session: SessionDep):
    rows = session.exec(
        select(Region, func.ST_AsGeoJSON(Region.geom))
        .where(Region.model_path != None)
    ).all()

    return [_row_to_dict(obj, geojson) for obj, geojson in rows]

@app.get("/regions/{id}")
async def get_region(id: int, session: SessionDep):
    row = session.exec(
        select(Region, func.ST_AsGeoJSON(Region.geom))
        .where(Region.id == id)
    ).first()

    if not row:
        return {"error": "Region not found"}
    
    obj, geojson = row
    
    return _row_to_dict(obj, geojson)

@app.get("/regions/{id}/model_path")
async def get_region_model_path(id: int, session: SessionDep):
    region = session.exec(
        select(Region)
        .where(Region.id == id)
    ).first()

    if not region:
        return {"error": "Region not found"}
    return {"model_path": region.model_path,
            "url": get_signed_url(region.model_path),
            "filename": region.model_path.split("/")[-1]
    }


# ---------------------------------------------------------------------------
# Splat ingestion: photos -> COLMAP + Gaussian splatting (on Modal) -> R2.
# See gpu/splat_app.py for the GPU worker and Plan.md for the full flow.
# ---------------------------------------------------------------------------

class CreateJobRequest(BaseModel):
    target_type: str          # "node" | "region"
    target_id: str            # OSMNode.node_id (as str) or Region.id
    filenames: list[str]      # photo filenames the client will upload


class WebhookRequest(BaseModel):
    status: str               # "done" | "failed"
    output_key: str | None = None
    error: str | None = None


@app.post("/jobs")
async def create_job(body: CreateJobRequest, session: SessionDep):
    """Create a job and hand back presigned PUT URLs to upload the photos to R2."""
    if body.target_type not in ("node", "region"):
        raise HTTPException(status_code=400, detail="target_type must be 'node' or 'region'")
    if not body.filenames:
        raise HTTPException(status_code=400, detail="filenames must not be empty")

    job_id = str(uuid.uuid4())
    input_prefix = f"inputs/{job_id}/"

    job = Job(
        id=job_id,
        status="pending",
        target_type=body.target_type,
        target_id=body.target_id,
        input_prefix=input_prefix,
    )
    session.add(job)
    session.commit()

    upload_urls = {
        name: get_upload_url(f"{input_prefix}{name}") for name in body.filenames
    }
    return {"job_id": job_id, "input_prefix": input_prefix, "upload_urls": upload_urls}


@app.post("/jobs/{job_id}/start")
async def start_job(job_id: str, session: SessionDep):
    """Kick off the GPU job on Modal once the photos have been uploaded."""
    import modal  # lazy import: keep the API importable even if modal is absent

    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status == "processing":
        return {"job_id": job_id, "status": job.status}

    output_key = f"models/{job_id}/scene.ply"
    backend_url = os.environ["BACKEND_PUBLIC_URL"].rstrip("/")
    webhook_url = f"{backend_url}/jobs/{job_id}/webhook"

    process = modal.Function.from_name("gisviz-splat", "process")
    call = process.spawn(job_id, job.input_prefix, output_key, webhook_url)

    job.output_key = output_key
    job.modal_call_id = getattr(call, "object_id", None)
    job.status = "processing"
    job.updated_at = datetime.now(timezone.utc)
    session.add(job)
    session.commit()
    return {"job_id": job_id, "status": job.status}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str, session: SessionDep):
    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "job_id": job.id,
        "status": job.status,
        "target_type": job.target_type,
        "target_id": job.target_id,
        "output_key": job.output_key,
        "error": job.error,
    }


@app.post("/jobs/{job_id}/webhook")
async def job_webhook(
    job_id: str,
    body: WebhookRequest,
    session: SessionDep,
    x_webhook_secret: Annotated[str | None, Header()] = None,
):
    """Called by the Modal worker on completion. Secret-verified before trust."""
    if x_webhook_secret != os.environ["JOB_WEBHOOK_SECRET"]:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    job = session.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if body.status == "done":
        output_key = body.output_key or job.output_key
        if job.target_type == "node":
            target = session.get(OSMNode, int(job.target_id))
        else:
            target = session.get(Region, job.target_id)
        if not target:
            raise HTTPException(status_code=404, detail="Target feature not found")
        target.model_path = output_key
        session.add(target)
        job.output_key = output_key
        job.status = "done"
    else:
        job.status = "failed"
        job.error = body.error

    job.updated_at = datetime.now(timezone.utc)
    session.add(job)
    session.commit()
    return {"job_id": job.id, "status": job.status}
