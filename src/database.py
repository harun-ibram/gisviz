import os
from collections.abc import Generator
from dotenv import load_dotenv
from sqlmodel import Session, create_engine


# load_dotenv("../../.env")



DATABASE_URL = os.environ.get("DB_URL")

print(DATABASE_URL)

engine = create_engine(DATABASE_URL, echo=False, pool_pre_ping=True)

