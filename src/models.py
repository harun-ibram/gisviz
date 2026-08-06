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
    # R2 key of the SuGaR mesh (.glb) extracted from the splat at model_path.
    # Independent of model_path: meshing runs after the splat is already served,
    # so a node can legitimately have one and not the other.
    mesh_path: str | None = Field(default=None, sa_column=Column("mesh_path", Text))


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
    # Nullable: a region created via POST /regions (name only, no drawn boundary
    # yet) has no geometry until one is assigned later.
    geom: Any | None = Field(default=None, sa_column=Column(GeometryType("MultiPolygon", 4326), nullable=True))
    model_path: str | None = Field(default=None, sa_column=Column("model_path", Text))
    # See OSMNode.mesh_path — the SuGaR mesh derived from model_path's splat.
    mesh_path: str | None = Field(default=None, sa_column=Column("mesh_path", Text))


class RasterLayer(SQLModel, table=True):
    """
    A web-ready raster overlay: colorized PNG + the WGS84 envelope that places
    it on the map. Rows come either from the CLI loader (src/load_gis.py,
    storage='static', paths under /overlays/) or from the upload pipeline
    (storage='r2', paths are R2 keys).
    """

    __tablename__ = "raster_layers"
    __table_args__ = {"schema": "public"}

    id: str = Field(primary_key=True)
    name: str = Field(nullable=False)
    kind: str = Field(default="dem")  # dem | dsm | raster
    layer_type: str = Field(default="tiff")  # tiff | lidar
    storage: str = Field(default="r2")  # r2 | static
    source: str | None = Field(default=None)
    src_crs: str | None = Field(default=None)
    overlay_path: str = Field(nullable=False)
    geotiff_path: str | None = Field(default=None, sa_column=Column("geotiff_path", Text))
    stats: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    properties: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    bounds: Any = Field(sa_column=Column(GeometryType("Polygon", 4326), nullable=False))
    job_id: str | None = Field(default=None, sa_column=Column("job_id", Text))
    created_at: datetime | None = Field(
        default=None,
        sa_column=Column("created_at", DateTime(timezone=True), server_default=text("now()")),
    )


class VectorLayer(SQLModel, table=True):
    """
    A processed vector layer. The features themselves live in R2 as a GeoJSON
    object (geojson_key); this row is metadata plus the envelope, so the map can
    decide whether a layer is even in view before fetching it.
    """

    __tablename__ = "vector_layers"
    __table_args__ = {"schema": "public"}

    id: str = Field(primary_key=True)
    name: str = Field(nullable=False)
    layer_type: str = Field(nullable=False)  # osm | geojson
    sublayer: str = Field(default="features")  # buildings | roads | features
    source: str | None = Field(default=None)
    src_crs: str | None = Field(default=None)
    geojson_key: str = Field(nullable=False)
    feature_count: int = Field(default=0, nullable=False)
    size_bytes: int | None = Field(default=None)
    properties: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    # Nullable: a layer whose features have no computable extent still indexes.
    bounds: Any | None = Field(
        default=None, sa_column=Column(GeometryType("Polygon", 4326), nullable=True)
    )
    job_id: str | None = Field(default=None, sa_column=Column("job_id", Text))
    created_at: datetime | None = Field(
        default=None,
        sa_column=Column("created_at", DateTime(timezone=True), server_default=text("now()")),
    )


class GisJob(SQLModel, table=True):
    """
    An upload -> process -> index run for one of the four GIS input types.

    Kept apart from public.jobs (the splat pipeline): that table's
    target_type/target_id are NOT NULL and meaningless here, its status
    vocabulary has no 'queued', and it carries a modal_call_id no GIS job has.
    """

    __tablename__ = "gis_jobs"
    __table_args__ = {"schema": "public"}

    id: str = Field(primary_key=True)
    layer_type: str = Field(nullable=False)  # tiff | osm | geojson | lidar
    name: str = Field(nullable=False)
    # awaiting_upload | queued | running | done | failed | cancelled
    status: str = Field(default="awaiting_upload")
    # while running: downloading | preflight | processing | uploading | indexing
    step: str | None = Field(default=None, sa_column=Column("step", Text))
    input_prefix: str = Field(nullable=False)
    input_files: list[Any] = Field(
        default_factory=list,
        sa_column=Column(JSONB, nullable=False, server_default=text("'[]'::jsonb")),
    )
    options: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    )
    layer_ids: list[Any] = Field(
        default_factory=list,
        sa_column=Column(JSONB, nullable=False, server_default=text("'[]'::jsonb")),
    )
    output_prefix: str | None = Field(default=None, sa_column=Column("output_prefix", Text))
    error: str | None = Field(default=None, sa_column=Column("error", Text))
    error_kind: str | None = Field(default=None, sa_column=Column("error_kind", Text))
    log: str | None = Field(default=None, sa_column=Column("log", Text))
    created_at: datetime | None = Field(
        default=None,
        sa_column=Column("created_at", DateTime(timezone=True), server_default=text("now()")),
    )
    started_at: datetime | None = Field(
        default=None, sa_column=Column("started_at", DateTime(timezone=True))
    )
    finished_at: datetime | None = Field(
        default=None, sa_column=Column("finished_at", DateTime(timezone=True))
    )
    updated_at: datetime | None = Field(
        default=None,
        sa_column=Column("updated_at", DateTime(timezone=True), server_default=text("now()")),
    )


class Job(SQLModel, table=True):
    __tablename__ = "jobs"
    __table_args__ = {"schema": "public"}

    # A splat-generation job: photos -> COLMAP + Gaussian splatting -> R2 -> model_path,
    # then SuGaR on top of that splat -> .glb in R2 -> mesh_path.
    id: str = Field(primary_key=True)
    # Deliberately still only about the *splat*: 'done' means the .ply is served.
    # Meshing runs afterwards and reports through mesh_status, so clients that
    # poll this field keep behaving exactly as they did before SuGaR existed.
    status: str = Field(default="pending")  # pending | processing | done | failed
    target_type: str = Field(nullable=False)  # "node" | "region"
    target_id: str = Field(nullable=False)  # OSMNode.node_id (as str) or Region.id
    input_prefix: str = Field(nullable=False)  # R2 key prefix holding uploaded photos
    output_key: str | None = Field(default=None, sa_column=Column("output_key", Text))
    modal_call_id: str | None = Field(default=None, sa_column=Column("modal_call_id", Text))
    error: str | None = Field(default=None, sa_column=Column("error", Text))
    # R2 prefix holding the handoff bundle the splat worker stages for SuGaR
    # (cameras.json, dataparser_transforms.json, the training images).
    work_prefix: str | None = Field(default=None, sa_column=Column("work_prefix", Text))
    mesh_key: str | None = Field(default=None, sa_column=Column("mesh_key", Text))
    # NULL until the splat finishes, then:
    # processing | done | failed | skipped (no bundle staged -> nothing to mesh)
    mesh_status: str | None = Field(default=None, sa_column=Column("mesh_status", Text))
    mesh_error: str | None = Field(default=None, sa_column=Column("mesh_error", Text))
    mesh_call_id: str | None = Field(default=None, sa_column=Column("mesh_call_id", Text))
    # Set when the uploaded photos were purged. Also the "can this be retried?"
    # flag: once the inputs are gone, re-running the job means re-uploading.
    inputs_deleted_at: datetime | None = Field(
        default=None, sa_column=Column("inputs_deleted_at", DateTime(timezone=True))
    )
    created_at: datetime | None = Field(
        default=None,
        sa_column=Column(
            "created_at", DateTime(timezone=True), server_default=text("now()")
        ),
    )
    updated_at: datetime | None = Field(
        default=None,
        sa_column=Column(
            "updated_at", DateTime(timezone=True), server_default=text("now()")
        ),
    )
