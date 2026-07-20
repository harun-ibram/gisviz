import json
from typing import Annotated, Any
 
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func
from sqlmodel import Session, SQLModel, select

from models import (
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
    connector = Connector(refresh_strategy="LAZY")

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
    allow_origins=["http://localhost:5173", "https://gisviz-xi.vercel.app/"],
    allow_methods=["*"],
    allow_headers=["*"]
)


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
        return {"model_path": node.model_path}
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
    return {"model_path": region.model_path}
    
