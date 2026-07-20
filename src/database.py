import os
from collections.abc import Generator
from dotenv import load_dotenv
from sqlmodel import Session, create_engine

load_dotenv("../.env")