import os
from collections.abc import Generator

from sqlmodel import Session, create_engine

DATABASE_URL = os.environ.get("DB_URL")

engine = create_engine(DATABASE_URL, echo=False, pool_pre_ping=True)


def get_session() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session