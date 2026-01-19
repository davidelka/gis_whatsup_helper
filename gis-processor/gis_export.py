"""
GIS export utilities for converting location data to various GIS formats.
"""
import os
import tempfile
import zipfile
from datetime import datetime
from typing import List, Optional

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point

from models import Location, Report


def locations_to_geodataframe(locations: List[Location]) -> gpd.GeoDataFrame:
    """Convert a list of Location objects to a GeoDataFrame."""
    if not locations:
        # Return empty GeoDataFrame with expected schema
        return gpd.GeoDataFrame(
            columns=[
                'id', 'message_id', 'latitude', 'longitude', 'accuracy',
                'name', 'address', 'url', 'group_id', 'group_name',
                'sender_id', 'sender_name', 'timestamp', 'report_text', 
                'Name', 'Description', 'geometry'
            ],
            geometry='geometry',
            crs='EPSG:4326'
        )
    
    # Create a list of dictionaries from location objects
    data = []
    for loc in locations:
        # Create a rich description for KML/GIS
        desc_parts = [
            f"<b>Sender:</b> {loc.sender_name or 'Unknown'}",
            f"<b>Group:</b> {loc.group_name or 'Private'}",
            f"<b>Time:</b> {loc.timestamp.strftime('%Y-%m-%d %H:%M:%S') if loc.timestamp else 'N/A'}"
        ]
        if loc.report_text:
            desc_parts.append(f"<br><b>Content:</b><br>{loc.report_text}")
        if loc.address:
            desc_parts.append(f"<br><b>Address:</b> {loc.address}")
        
        description = "<br>".join(desc_parts)

        data.append({
            'id': loc.id,
            'message_id': loc.message_id,
            'report_id': loc.report_id,
            'latitude': loc.latitude,
            'longitude': loc.longitude,
            'accuracy': loc.accuracy,
            'name': loc.name,
            'address': loc.address,
            'url': loc.url,
            'group_id': loc.group_id,
            'group_name': loc.group_name,
            'sender_id': loc.sender_id,
            'sender_name': loc.sender_name,
            'timestamp': loc.timestamp.isoformat() if loc.timestamp else None,
            'rpt_text': loc.report_text,
            'Name': loc.name or loc.sender_name or f"Loc {loc.id}", # Specifically for KML
            'Description': description, # Specifically for KML
            'geometry': Point(loc.longitude, loc.latitude)
        })
    
    # Create GeoDataFrame
    gdf = gpd.GeoDataFrame(data, geometry='geometry', crs='EPSG:4326')
    return gdf


def reports_to_geodataframe(reports: List[Report]) -> gpd.GeoDataFrame:
    """Convert a list of Report objects to a GeoDataFrame."""
    if not reports:
        return gpd.GeoDataFrame(
            columns=[
                'id', 'report_id', 'group_id', 'group_name', 'sender_id',
                'sender_name', 'started_at', 'ended_at', 'status',
                'message_count', 'location_name', 'location_address', 
                'report_text', 'Name', 'Description', 'geometry'
            ],
            geometry='geometry',
            crs='EPSG:4326'
        )
    
    data = []
    for report in reports:
        if report.latitude is not None and report.longitude is not None:
            # Concatenate all messages into a single text block
            messages = report.get_messages()
            text_parts = []
            for msg in messages:
                sender = msg.get('senderName', 'Unknown')
                text = msg.get('text') or msg.get('caption') or ''
                if text:
                    text_parts.append(f"{sender}: {text}")
            
            report_text = "\n".join(text_parts)
            
            # Rich HTML Description for KML
            html_desc_parts = [
                f"<b>Sender:</b> {report.sender_name or 'Unknown'}",
                f"<b>Status:</b> {report.status}",
                f"<b>Time:</b> {report.started_at.strftime('%Y-%m-%d %H:%M') if report.started_at else 'N/A'}",
                f"<b>Messages:</b> {report.message_count}",
                f"<br><b>Full Report:</b><br>{report_text.replace(chr(10), '<br>')}"
            ]
            description = "<br>".join(html_desc_parts)

            data.append({
                'id': report.id,
                'report_id': report.report_id,
                'group_id': report.group_id,
                'group_name': report.group_name,
                'sender_id': report.sender_id,
                'sender_name': report.sender_name,
                'started_at': report.started_at.isoformat() if report.started_at else None,
                'ended_at': report.ended_at.isoformat() if report.ended_at else None,
                'status': report.status,
                'msg_count': report.message_count,
                'loc_name': report.location_name,
                'loc_addr': report.location_address,
                'report_text': report_text,
                'latitude': report.latitude,
                'longitude': report.longitude,
                'Name': report.location_name or report.sender_name or f"Report {report.report_id}",
                'Description': description,
                'geometry': Point(report.longitude, report.latitude)
            })
    
    gdf = gpd.GeoDataFrame(data, geometry='geometry', crs='EPSG:4326')
    return gdf


def export_to_geojson(locations: List[Location], output_path: str) -> str:
    """Export locations to GeoJSON format."""
    gdf = locations_to_geodataframe(locations)
    
    # Ensure output directory exists
    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)
    
    gdf.to_file(output_path, driver='GeoJSON')
    return output_path


def export_reports_to_geojson(reports: List[Report], output_path: str) -> str:
    """Export reports to GeoJSON format."""
    gdf = reports_to_geodataframe(reports)
    
    # Ensure output directory exists
    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)
    
    gdf.to_file(output_path, driver='GeoJSON')
    return output_path


def export_to_shapefile(locations: List[Location], output_path: str) -> str:
    """
    Export locations to Shapefile format.
    Returns the path to a ZIP file containing all shapefile components.
    """
    gdf = locations_to_geodataframe(locations)
    
    # Shapefiles have a 10-character limit on field names
    # Rename columns to fit this limit
    column_mapping = {
        'message_id': 'msg_id',
        'report_id': 'rpt_id',
        'latitude': 'lat',
        'longitude': 'lon',
        'accuracy': 'accuracy',
        'name': 'name',
        'address': 'address',
        'url': 'url',
        'group_id': 'grp_id',
        'group_name': 'grp_name',
        'sender_id': 'sndr_id',
        'sender_name': 'sndr_name',
        'timestamp': 'timestamp',
        'rpt_text': 'rpt_text'
    }
    
    gdf_renamed = gdf.rename(columns=column_mapping)
    
    # Create a temporary directory for shapefile components
    with tempfile.TemporaryDirectory() as temp_dir:
        shapefile_base = os.path.join(temp_dir, 'locations')
        gdf_renamed.to_file(shapefile_base + '.shp', driver='ESRI Shapefile')
        
        # Ensure output directory exists
        output_dir = os.path.dirname(output_path)
        if output_dir and not os.path.exists(output_dir):
            os.makedirs(output_dir, exist_ok=True)
        
        # Create a ZIP file containing all shapefile components
        if not output_path.endswith('.zip'):
            output_path = output_path + '.zip'
        
        with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for ext in ['.shp', '.shx', '.dbf', '.prj', '.cpg']:
                filepath = shapefile_base + ext
                if os.path.exists(filepath):
                    zipf.write(filepath, 'locations' + ext)
    
    return output_path


def export_to_kml(locations: List[Location], output_path: str) -> str:
    """Export locations to KML format (for Google Earth)."""
    gdf = locations_to_geodataframe(locations)
    
    # Ensure output directory exists
    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)
    
    # KML requires specific driver
    gdf.to_file(output_path, driver='KML')
    return output_path


def export_to_gpkg(locations: List[Location], output_path: str) -> str:
    """Export locations to GeoPackage format."""
    gdf = locations_to_geodataframe(locations)
    
    # Ensure output directory exists
    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)
    
    gdf.to_file(output_path, driver='GPKG', layer='locations')
    return output_path


def generate_export_filename(format_type: str) -> str:
    """Generate a timestamped filename for exports."""
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    extensions = {
        'geojson': '.geojson',
        'shapefile': '.zip',
        'kml': '.kml',
        'gpkg': '.gpkg'
    }
    ext = extensions.get(format_type, '.geojson')
    return f'locations_{timestamp}{ext}'

