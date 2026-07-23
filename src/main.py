import json
from typing import Annotated, Any
 
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func
from sqlmodel import Session, SQLModel, select

import boto3
from botocore.config import Config

from database import get_session
from models import (
    OSMNode,
    OSMRelation,
    OSMRelationMember,
    OSMWay,
    OSMWayNode,
    Region,
)


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


# FastAPI and middleware
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "https://gisviz.vercel.app"],
    allow_methods=["*"],
    allow_headers=["*"]
)

# Type annotation and dependency for Session
SessionDep = Annotated[Session, Depends(get_session)]

# Helper function for formatting the data in the table into a usable object
def _row_to_dict(obj: SQLModel, geojson: str | None) -> dict[str, Any]:
    data = obj.model_dump(exclude="geom")
    data["geom"] = json.loads(geojson) if geojson else None
    return data


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

    if node:
        return {"model_path": node.model_path,
                "url": get_signed_url(node.model_path),
                "filename": node.model_path.split("/")[-1]}
    return {"error": "Node not found"}
    
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
    
