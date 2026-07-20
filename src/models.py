from datetime import datetime
from typing import Any

from sqlalchemy import Column, DateTime, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.types import UserDefinedType
from sqlmodel import Field, SQLModel


class GeometryType(UserDefinedType):
    def __init__(self, geometry_type: str = "Geometry", srid: int = 4326) -> None:
        self.geometry_type = geometry_type
        self.srid = srid

    def get_col_spec(self, **kw: Any) -> str:
        return f"GEOMETRY({self.geometry_type}, {self.srid})"


class OSMNode(SQLModel, table=True):
    __tablename__ = "nodes"
    __table_args__ = {"schema": "osm"}

    node_id: int = Field(primary_key=True)
    version: int | None = Field(default=None)
    changeset: int | None = Field(default=None)
    user: str | None = Field(default=None, sa_column=Column("user", Text))
    uid: int | None = Field(default=None)
    timestamp: datetime | None = Field(
        default=None, sa_column=Column("timestamp", DateTime(timezone=True))
    )
    geom: Any = Field(sa_column=Column(GeometryType("Point", 4326), nullable=False))
    tags: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    model_path: str | None = Field(default=None, sa_column=Column("model_path", Text))


class OSMWay(SQLModel, table=True):
    __tablename__ = "ways"
    __table_args__ = {"schema": "osm"}

    way_id: int = Field(primary_key=True)
    version: int | None = Field(default=None)
    changeset: int | None = Field(default=None)
    user: str | None = Field(default=None, sa_column=Column("user", Text))
    uid: int | None = Field(default=None)
    timestamp: datetime | None = Field(
        default=None, sa_column=Column("timestamp", DateTime(timezone=True))
    )
    tags: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    is_area: bool = Field(default=False, nullable=False)
    geom: Any | None = Field(default=None, sa_column=Column(GeometryType(), nullable=True))


class OSMWayNode(SQLModel, table=True):
    __tablename__ = "way_nodes"
    __table_args__ = {"schema": "osm"}

    way_id: int = Field(foreign_key="osm.ways.way_id", primary_key=True)
    node_id: int = Field(foreign_key="osm.nodes.node_id")
    sequence_id: int = Field(primary_key=True)


class OSMRelation(SQLModel, table=True):
    __tablename__ = "relations"
    __table_args__ = {"schema": "osm"}

    relation_id: int = Field(primary_key=True)
    version: int | None = Field(default=None)
    changeset: int | None = Field(default=None)
    user: str | None = Field(default=None, sa_column=Column("user", Text))
    uid: int | None = Field(default=None)
    timestamp: datetime | None = Field(
        default=None, sa_column=Column("timestamp", DateTime(timezone=True))
    )
    tags: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    geom: Any | None = Field(default=None, sa_column=Column(GeometryType(), nullable=True))


class OSMRelationMember(SQLModel, table=True):
    __tablename__ = "relation_members"
    __table_args__ = {"schema": "osm"}

    relation_id: int = Field(
        foreign_key="osm.relations.relation_id", primary_key=True
    )
    member_type: str = Field(default="", index=False)
    member_id: int = Field()
    role: str = Field(default="")
    sequence_id: int = Field(primary_key=True)


class Region(SQLModel, table=True):
    __tablename__ = "regions"
    __table_args__ = {"schema": "public"}

    id: str = Field(primary_key=True)
    name: str = Field(nullable=False)
    source: str | None = Field(default=None)
    properties: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    geom: Any = Field(sa_column=Column(GeometryType("MultiPolygon", 4326), nullable=False))
    model_path: str | None = Field(default=None, sa_column=Column("model_path", Text))
