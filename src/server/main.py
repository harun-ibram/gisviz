from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from models import (  # noqa: F401
    OSMNode,
    OSMRelation,
    OSMRelationMember,
    OSMWay,
    OSMWayNode,
    Region,
)


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"]
)

