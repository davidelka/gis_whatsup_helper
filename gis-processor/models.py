"""
Database models for storing WhatsApp messages, locations, and reports.
"""
import os
import json
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, Text, Boolean, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship

Base = declarative_base()


class Message(Base):
    """Store all WhatsApp messages."""
    __tablename__ = 'messages'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    message_id = Column(String(100), unique=True, nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow)
    group_id = Column(String(100), nullable=False)
    group_name = Column(String(255), nullable=True)
    sender_id = Column(String(100), nullable=False)
    sender_name = Column(String(255), nullable=True)
    message_type = Column(String(50), nullable=False)
    text = Column(Text, nullable=True)
    media_type = Column(String(50), nullable=True)
    caption = Column(Text, nullable=True)
    has_location = Column(Boolean, default=False)
    media_path = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    def to_dict(self):
        return {
            'id': self.id,
            'message_id': self.message_id,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'group_id': self.group_id,
            'group_name': self.group_name,
            'sender_id': self.sender_id,
            'sender_name': self.sender_name,
            'message_type': self.message_type,
            'text': self.text,
            'media_type': self.media_type,
            'caption': self.caption,
            'has_location': self.has_location,
            'media_url': f"/media/{os.path.basename(self.media_path)}" if self.media_path else None,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }


class Location(Base):
    """Store location data with geometry."""
    __tablename__ = 'locations'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    message_id = Column(String(100), nullable=False)
    report_id = Column(String(100), nullable=True)  # Link to report if from a report
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    accuracy = Column(Float, nullable=True)
    name = Column(String(255), nullable=True)
    address = Column(Text, nullable=True)
    url = Column(String(500), nullable=True)
    group_id = Column(String(100), nullable=False)
    group_name = Column(String(255), nullable=True)
    sender_id = Column(String(100), nullable=False)
    sender_name = Column(String(255), nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
    report_text = Column(Text, nullable=True) # Full text if part of a report
    media_path = Column(String(500), nullable=True)
    tags_json = Column(Text, nullable=True)  # Tags as JSON array for filtering
    is_visible = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    def get_tags(self) -> list:
        """Get tags as a list."""
        if self.tags_json:
            try:
                return json.loads(self.tags_json)
            except:
                return []
        return []

    def set_tags(self, tags: list):
        """Set tags from a list."""
        if tags:
            self.tags_json = json.dumps(tags)
        else:
            self.tags_json = None

    def to_dict(self):
        return {
            'id': self.id,
            'message_id': self.message_id,
            'report_id': self.report_id,
            'latitude': self.latitude,
            'longitude': self.longitude,
            'accuracy': self.accuracy,
            'name': self.name,
            'address': self.address,
            'url': self.url,
            'group_id': self.group_id,
            'group_name': self.group_name,
            'sender_id': self.sender_id,
            'sender_name': self.sender_name,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'report_text': self.report_text,
            'media_url': f"/media/{os.path.basename(self.media_path)}" if self.media_path else None,
            'tags': self.get_tags(),
            'is_visible': self.is_visible,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }


class Track(Base):
    """Store track/line geometries imported from KML or other GIS files."""
    __tablename__ = 'tracks'

    id = Column(Integer, primary_key=True, autoincrement=True)
    track_id = Column(String(100), unique=True, nullable=False)
    name = Column(String(255), nullable=True)
    description = Column(Text, nullable=True)
    geometry_json = Column(Text, nullable=False)  # GeoJSON geometry (LineString/MultiLineString)
    group_id = Column(String(100), nullable=False)
    group_name = Column(String(255), nullable=True)
    sender_id = Column(String(100), nullable=False)
    sender_name = Column(String(255), nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
    source_filename = Column(String(255), nullable=True)
    tags_json = Column(Text, nullable=True)
    is_visible = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    def get_tags(self) -> list:
        if self.tags_json:
            try:
                return json.loads(self.tags_json)
            except:
                return []
        return []

    def set_tags(self, tags: list):
        if tags:
            self.tags_json = json.dumps(tags)
        else:
            self.tags_json = None

    def to_dict(self):
        return {
            'id': self.id,
            'track_id': self.track_id,
            'name': self.name,
            'description': self.description,
            'geometry': json.loads(self.geometry_json) if self.geometry_json else None,
            'group_id': self.group_id,
            'group_name': self.group_name,
            'sender_id': self.sender_id,
            'sender_name': self.sender_name,
            'timestamp': self.timestamp.isoformat() if self.timestamp else None,
            'source_filename': self.source_filename,
            'tags': self.get_tags(),
            'is_visible': self.is_visible,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }


class Report(Base):
    """Store reports (messages between תד and סד)."""
    __tablename__ = 'reports'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    report_id = Column(String(100), unique=True, nullable=False)
    group_id = Column(String(100), nullable=False)
    group_name = Column(String(255), nullable=True)
    sender_id = Column(String(100), nullable=False)
    sender_name = Column(String(255), nullable=True)
    started_at = Column(DateTime, nullable=False)
    ended_at = Column(DateTime, nullable=True)
    status = Column(String(20), nullable=False)  # 'complete', 'invalid'
    message_count = Column(Integer, default=0)
    
    # Location data
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    accuracy = Column(Float, nullable=True)
    location_name = Column(String(255), nullable=True)
    location_address = Column(Text, nullable=True)
    
    # Store all messages as JSON
    messages_json = Column(Text, nullable=True)

    tags_json = Column(Text, nullable=True)  # Tags as JSON array for filtering
    is_visible = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    def set_messages(self, messages: list):
        """Store messages as JSON."""
        self.messages_json = json.dumps(messages)

    def get_messages(self) -> list:
        """Retrieve messages from JSON."""
        if self.messages_json:
            return json.loads(self.messages_json)
        return []

    def get_tags(self) -> list:
        """Get tags as a list."""
        if self.tags_json:
            try:
                return json.loads(self.tags_json)
            except:
                return []
        return []

    def set_tags(self, tags: list):
        """Set tags from a list."""
        if tags:
            self.tags_json = json.dumps(tags)
        else:
            self.tags_json = None

    def to_dict(self):
        return {
            'id': self.id,
            'report_id': self.report_id,
            'group_id': self.group_id,
            'group_name': self.group_name,
            'sender_id': self.sender_id,
            'sender_name': self.sender_name,
            'started_at': self.started_at.isoformat() if self.started_at else None,
            'ended_at': self.ended_at.isoformat() if self.ended_at else None,
            'status': self.status,
            'message_count': self.message_count,
            'latitude': self.latitude,
            'longitude': self.longitude,
            'accuracy': self.accuracy,
            'location_name': self.location_name,
            'location_address': self.location_address,
            'messages': self.get_messages(),
            'tags': self.get_tags(),
            'is_visible': self.is_visible,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }


def get_engine(database_url: str):
    """Create database engine."""
    # Ensure the directory exists for SQLite
    if database_url.startswith('sqlite:///'):
        db_path = database_url.replace('sqlite:///', '')
        db_dir = os.path.dirname(db_path)
        if db_dir and not os.path.exists(db_dir):
            os.makedirs(db_dir, exist_ok=True)
    
    return create_engine(database_url, echo=False)


def get_session(engine):
    """Create database session."""
    Session = sessionmaker(bind=engine)
    return Session()


def init_db(database_url: str):
    """Initialize the database and create tables."""
    engine = get_engine(database_url)
    Base.metadata.create_all(engine)
    return engine
