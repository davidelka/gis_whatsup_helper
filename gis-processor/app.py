"""
Flask API server for receiving WhatsApp messages, reports, and exporting GIS data.
"""
import os
import sys
from datetime import datetime
import base64
import uuid
from flask import Flask, request, jsonify, send_file, send_from_directory
from flask_cors import CORS
import yaml

# Add the current directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from models import Message, Location, Report, Track, ListenerGroup, init_db, get_session, get_engine
from service_manager import ServiceManager
from gis_export import (
    export_to_geojson, 
    export_to_shapefile, 
    export_to_kml, 
    export_to_gpkg,
    generate_export_filename,
    export_reports_to_geojson
)

app = Flask(__name__)
CORS(app)

# Load configuration
def load_config():
    config_path = os.path.join(os.path.dirname(__file__), '..', 'config.yaml')
    if os.path.exists(config_path):
        with open(config_path, 'r') as f:
            return yaml.safe_load(f)
    return {
        'storage': {
            'database': 'sqlite:///data/messages.db',
            'export_dir': './exports'
        },
        'python_service': {
            'host': 'localhost',
            'port': 5000
        }
    }

config = load_config()
database_url = config['storage']['database']
export_dir = config['storage']['export_dir']
media_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'media')
os.makedirs(media_dir, exist_ok=True)

# Initialize database
engine = init_db(database_url)


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({'status': 'healthy', 'service': 'gis-processor'})


@app.route('/media/<path:filename>')
def serve_media(filename):
    """Serve media files from the media directory."""
    return send_from_directory(media_dir, filename)


def save_media_from_data(data):
    """Save base64 media data to disk and return the relative path."""
    if not data.get('mediaData'):
        return None
    
    try:
        media_data = base64.b64decode(data['mediaData'])
        filename = f"{uuid.uuid4()}_{data.get('mediaFilename', 'image.jpg')}"
        file_path = os.path.join(media_dir, filename)
        
        with open(file_path, 'wb') as f:
            f.write(media_data)
        
        return os.path.join('data', 'media', filename)
    except Exception as e:
        app.logger.error(f"Error saving media: {str(e)}")
        return None


@app.route('/message', methods=['POST'])
def receive_message():
    """Receive a message from the WhatsApp listener."""
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        
        session = get_session(engine)
        
        try:
            # Check if message already exists
            existing = session.query(Message).filter_by(message_id=data.get('id')).first()
            if existing:
                return jsonify({'status': 'duplicate', 'message_id': data.get('id')}), 200
            
            # Parse timestamp
            timestamp = None
            if data.get('timestamp'):
                try:
                    timestamp = datetime.fromtimestamp(data['timestamp'])
                except:
                    timestamp = datetime.utcnow()
            
            # Create message record
            message = Message(
                message_id=data.get('id', ''),
                timestamp=timestamp,
                group_id=data.get('groupId', ''),
                group_name=data.get('groupName'),
                sender_id=data.get('senderId', ''),
                sender_name=data.get('senderName'),
                message_type=data.get('messageType', 'unknown'),
                text=data.get('text'),
                media_type=data.get('mediaType'),
                caption=data.get('caption'),
                has_location=bool(data.get('location')),
                media_path=save_media_from_data(data)
            )
            session.add(message)
            
            # If message has location, store it separately
            if data.get('location'):
                loc_data = data['location']
                location = Location(
                    message_id=data.get('id', ''),
                    latitude=loc_data.get('latitude', 0),
                    longitude=loc_data.get('longitude', 0),
                    accuracy=loc_data.get('accuracy'),
                    name=loc_data.get('name'),
                    address=loc_data.get('address'),
                    url=loc_data.get('url'),
                    group_id=data.get('groupId', ''),
                    group_name=data.get('groupName'),
                    sender_id=data.get('senderId', ''),
                    sender_name=data.get('senderName'),
                    report_id=data.get('reportId'),
                    timestamp=timestamp
                )
                session.add(location)
            
            session.commit()
            
            app.logger.info(f"Stored message: {data.get('id')} (type: {data.get('messageType')})")
            
            return jsonify({
                'status': 'success',
                'message_id': data.get('id'),
                'has_location': bool(data.get('location'))
            }), 201
            
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()
            
    except Exception as e:
        app.logger.error(f"Error processing message: {str(e)}")
        return jsonify({'error': str(e)}), 500


@app.route('/report', methods=['POST'])
def receive_report():
    """Receive a report from the WhatsApp listener (messages between תד and סד)."""
    try:
        data = request.get_json()
        
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        
        session = get_session(engine)
        
        try:
            report_id = data.get('id', '')
            status = data.get('status', 'unknown')
            
            # Check if report already exists
            existing = session.query(Report).filter_by(report_id=report_id).first()
            if existing:
                return jsonify({'status': 'duplicate', 'report_id': report_id}), 200
            
            # Parse timestamps
            started_at = None
            ended_at = None
            if data.get('startedAt'):
                try:
                    started_at = datetime.fromtimestamp(data['startedAt'])
                except:
                    started_at = datetime.utcnow()
            if data.get('endedAt'):
                try:
                    ended_at = datetime.fromtimestamp(data['endedAt'])
                except:
                    ended_at = datetime.utcnow()
            
            # Extract location from report
            location_data = data.get('location', {})
            
            # Create report record
            report = Report(
                report_id=report_id,
                group_id=data.get('groupId', ''),
                group_name=data.get('groupName'),
                sender_id=data.get('senderId', ''),
                sender_name=data.get('senderName'),
                started_at=started_at or datetime.utcnow(),
                ended_at=ended_at,
                status=status,
                message_count=len(data.get('messages', [])),
                latitude=location_data.get('latitude') if location_data else None,
                longitude=location_data.get('longitude') if location_data else None,
                accuracy=location_data.get('accuracy') if location_data else None,
                location_name=location_data.get('name') if location_data else None,
                location_address=location_data.get('address') if location_data else None,
            )
            
            # Store messages as JSON
            report.set_messages(data.get('messages', []))
            
            session.add(report)
            
            # Also store location in locations table for GIS export
            # DEDUPLICATION: Check if this location (message_id = report_id) exists already
            existing_loc = session.query(Location).filter_by(message_id=report_id).first()
            
            if not existing_loc and location_data and location_data.get('latitude') and location_data.get('longitude'):
                location = Location(
                    message_id=report_id,
                    report_id=report_id,
                    latitude=location_data.get('latitude', 0),
                    longitude=location_data.get('longitude', 0),
                    accuracy=location_data.get('accuracy'),
                    name=location_data.get('name'),
                    address=location_data.get('address'),
                    url=location_data.get('url'),
                    group_id=data.get('groupId', ''),
                    group_name=data.get('groupName'),
                    sender_id=data.get('senderId', ''),
                    sender_name=data.get('senderName'),
                    timestamp=started_at
                )
                
                # Check for images in the report messages to associate with the location
                report_media_path = None
                for msg_data in data.get('messages', []):
                    if msg_data.get('mediaData'):
                        report_media_path = save_media_from_data(msg_data)
                        if report_media_path:
                            break
                
                location.media_path = report_media_path
                
                # Use formatted text for easier GIS viewing
                messages = report.get_messages()
                text_parts = []
                for msg in messages:
                    sender = msg.get('senderName', 'Unknown')
                    text = msg.get('text') or msg.get('caption') or ''
                    if text:
                        text_parts.append(f"{sender}: {text}")
                
                location.report_text = "\n".join(text_parts)
                session.add(location)
            
            session.commit()
            
            if status == 'complete':
                app.logger.info(f"✅ Stored complete report: {report_id} ({report.message_count} messages)")
            else:
                app.logger.warning(f"⚠️ Stored invalid report (no location): {report_id}")
            
            return jsonify({
                'status': 'success',
                'report_id': report_id,
                'report_status': status,
                'has_location': bool(location_data),
                'message_count': report.message_count
            }), 201
            
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()
            
    except Exception as e:
        app.logger.error(f"Error processing report: {str(e)}")
        return jsonify({'error': str(e)}), 500


@app.route('/reports', methods=['GET'])
def list_reports():
    """List all stored reports."""
    session = get_session(engine)
    try:
        # Filter by status and/or sender_id if provided
        status_filter = request.args.get('status')
        sender_id_filter = request.args.get('sender_id')

        query = session.query(Report).order_by(Report.started_at.desc())

        if status_filter:
            query = query.filter_by(status=status_filter)
        if sender_id_filter:
            query = query.filter_by(sender_id=sender_id_filter)

        reports = query.limit(100).all()
        
        return jsonify({
            'count': len(reports),
            'reports': [r.to_dict() for r in reports]
        })
    finally:
        session.close()


@app.route('/reports/<report_id>', methods=['GET'])
def get_report(report_id):
    """Get a specific report by ID."""
    session = get_session(engine)
    try:
        report = session.query(Report).filter_by(report_id=report_id).first()
        
        if not report:
            return jsonify({'error': 'Report not found'}), 404
        
        return jsonify(report.to_dict())
    finally:
        session.close()


@app.route('/api/reports/<report_id>', methods=['PATCH'])
def update_report(report_id):
    """Update report properties (visibility, tag, etc.)."""
    session = get_session(engine)
    try:
        report = session.query(Report).filter_by(report_id=report_id).first()
        if not report:
            return jsonify({'error': 'Report not found'}), 404

        data = request.get_json()
        updated = False

        if 'is_visible' in data:
            new_visibility = bool(data['is_visible'])
            report.is_visible = new_visibility

            # Toggle visibility of ALL associated locations
            locations = session.query(Location).filter_by(report_id=report_id).all()
            for loc in locations:
                loc.is_visible = new_visibility
            updated = True

        if 'tags' in data:
            new_tags = data['tags'] if data['tags'] else []
            # Ensure it's a list
            if isinstance(new_tags, str):
                new_tags = [new_tags] if new_tags else []
            report.set_tags(new_tags)

            # Update tags on ALL associated locations
            locations = session.query(Location).filter_by(report_id=report_id).all()
            for loc in locations:
                loc.set_tags(new_tags)
            updated = True

        if updated:
            session.commit()
            return jsonify({'status': 'success', 'is_visible': report.is_visible, 'tags': report.get_tags()})

        return jsonify({'error': 'No valid data provided'}), 400
    finally:
        session.close()


@app.route('/api/reports/<report_id>', methods=['DELETE'])
def delete_report(report_id):
    """Delete a report and its associated location."""
    session = get_session(engine)
    try:
        report = session.query(Report).filter_by(report_id=report_id).first()
        if not report:
            return jsonify({'error': 'Report not found'}), 404
        
        # Delete ALL associated locations
        locations = session.query(Location).filter_by(report_id=report_id).all()
        for loc in locations:
            session.delete(loc)
            
        session.delete(report)
        session.commit()
        return jsonify({'status': 'success', 'message': f'Report {report_id} deleted'})
    finally:
        session.close()


@app.route('/api/locations/<int:loc_id>', methods=['PATCH'])
def toggle_location_visibility(loc_id):
    """Toggle the visibility of a specific location."""
    session = get_session(engine)
    try:
        location = session.query(Location).filter_by(id=loc_id).first()
        if not location:
            return jsonify({'error': 'Location not found'}), 404
        
        data = request.get_json()
        if 'is_visible' in data:
            location.is_visible = bool(data['is_visible'])
            session.commit()
            return jsonify({'status': 'success', 'is_visible': location.is_visible})
        
        return jsonify({'error': 'No visibility data provided'}), 400
    finally:
        session.close()


@app.route('/api/locations/<int:loc_id>', methods=['DELETE'])
def delete_location(loc_id):
    """Delete a specific location."""
    session = get_session(engine)
    try:
        location = session.query(Location).filter_by(id=loc_id).first()
        if not location:
            return jsonify({'error': 'Location not found'}), 404
        
        session.delete(location)
        session.commit()
        return jsonify({'status': 'success', 'message': f'Location {loc_id} deleted'})
    finally:
        session.close()


@app.route('/messages', methods=['GET'])
def list_messages():
    """List all stored messages."""
    session = get_session(engine)
    try:
        messages = session.query(Message).order_by(Message.timestamp.desc()).limit(100).all()
        return jsonify({
            'count': len(messages),
            'messages': [msg.to_dict() for msg in messages]
        })
    finally:
        session.close()


@app.route('/locations', methods=['GET'])
def list_locations():
    """List all stored locations. Supports optional group and from_date/to_date filters."""
    session = get_session(engine)
    try:
        query = session.query(Location).order_by(Location.timestamp.desc())
        query = apply_location_filters(query, request.args)
        locations = query.all()
        return jsonify({
            'count': len(locations),
            'locations': [loc.to_dict() for loc in locations]
        })
    finally:
        session.close()


def apply_location_filters(query, args):
    """Apply filter parameters to a Location query."""
    from datetime import datetime
    import json

    app.logger.info(f"Applying filters: {dict(args)}")

    # Date filters
    from_date = args.get('from_date')
    to_date = args.get('to_date')
    if from_date:
        try:
            from_dt = datetime.fromisoformat(from_date)
            query = query.filter(Location.timestamp >= from_dt)
            app.logger.info(f"Applied from_date filter: {from_dt}")
        except Exception as e:
            app.logger.warning(f"Failed to parse from_date: {e}")
    if to_date:
        try:
            to_dt = datetime.fromisoformat(to_date + 'T23:59:59')
            query = query.filter(Location.timestamp <= to_dt)
            app.logger.info(f"Applied to_date filter: {to_dt}")
        except Exception as e:
            app.logger.warning(f"Failed to parse to_date: {e}")

    # Tag filter - only handle "no tag" filter in SQL
    # Specific tag filtering is done client-side after fetching
    tag_filter = args.get('tag')
    if tag_filter and tag_filter == '__no_tag__':
        query = query.filter(Location.tags_json.is_(None))
        app.logger.info("Applied no_tag filter")

    # Group filter
    group = args.get('group')
    if group:
        query = query.filter(Location.group_name == group)
        app.logger.info(f"Applied group filter: {group}")

    return query


def filter_locations_by_tag(locations, tag):
    """Filter locations by tag (client-side filtering for JSON arrays)."""
    filtered = []
    for loc in locations:
        tags = loc.get_tags()
        if tag in tags:
            filtered.append(loc)
    return filtered


@app.route('/export/geojson', methods=['GET'])
def export_geojson():
    """Export visible locations as GeoJSON."""
    session = get_session(engine)
    try:
        # Check if we should export only report locations
        reports_only = request.args.get('reports_only', 'false').lower() == 'true'

        # Start with base query
        query = session.query(Location).filter_by(is_visible=True)
        base_count = query.count()
        app.logger.info(f"Base visible locations count: {base_count}")

        if reports_only:
            query = query.filter(Location.report_id.isnot(None))
            app.logger.info(f"After reports_only filter: {query.count()}")

        # Apply additional filters
        query = apply_location_filters(query, request.args)
        locations = query.all()

        # Apply tag filter client-side if needed
        tag_filter = request.args.get('tag')
        if tag_filter and tag_filter != '__no_tag__':
            locations = filter_locations_by_tag(locations, tag_filter)
            app.logger.info(f"After tag filter '{tag_filter}': {len(locations)} locations")

        app.logger.info(f"Final filtered locations count: {len(locations)}")

        if not locations:
            return jsonify({'error': 'No visible locations to export'}), 404
        
        filename = generate_export_filename('geojson')
        output_path = os.path.join(export_dir, filename)
        
        export_to_geojson(locations, output_path)
        
        return send_file(
            output_path,
            mimetype='application/geo+json',
            as_attachment=True,
            download_name=filename
        )
    finally:
        session.close()


@app.route('/export/reports/geojson', methods=['GET'])
def export_reports_geojson():
    """Export visible complete reports as GeoJSON."""
    session = get_session(engine)
    try:
        reports = session.query(Report).filter_by(status='complete', is_visible=True).all()
        
        if not reports:
            return jsonify({'error': 'No visible complete reports to export'}), 404
        
        filename = f"reports_{datetime.now().strftime('%Y%m%d_%H%M%S')}.geojson"
        output_path = os.path.join(export_dir, filename)
        
        export_reports_to_geojson(reports, output_path)
        
        return send_file(
            output_path,
            mimetype='application/geo+json',
            as_attachment=True,
            download_name=filename
        )
    finally:
        session.close()


@app.route('/export/shapefile', methods=['GET'])
def export_shapefile():
    """Export visible locations as Shapefile (ZIP)."""
    session = get_session(engine)
    try:
        query = session.query(Location).filter_by(is_visible=True)
        query = apply_location_filters(query, request.args)
        locations = query.all()

        # Apply tag filter client-side if needed
        tag_filter = request.args.get('tag')
        if tag_filter and tag_filter != '__no_tag__':
            locations = filter_locations_by_tag(locations, tag_filter)

        if not locations:
            return jsonify({'error': 'No visible locations to export'}), 404
        
        filename = generate_export_filename('shapefile')
        output_path = os.path.join(export_dir, filename)
        
        actual_path = export_to_shapefile(locations, output_path)
        
        return send_file(
            actual_path,
            mimetype='application/zip',
            as_attachment=True,
            download_name=os.path.basename(actual_path)
        )
    finally:
        session.close()


@app.route('/export/kml', methods=['GET'])
def export_kml():
    """Export visible locations as KML (Google Earth)."""
    session = get_session(engine)
    try:
        query = session.query(Location).filter_by(is_visible=True)
        query = apply_location_filters(query, request.args)
        locations = query.all()

        # Apply tag filter client-side if needed
        tag_filter = request.args.get('tag')
        if tag_filter and tag_filter != '__no_tag__':
            locations = filter_locations_by_tag(locations, tag_filter)

        if not locations:
            return jsonify({'error': 'No visible locations to export'}), 404
        
        filename = generate_export_filename('kml')
        output_path = os.path.join(export_dir, filename)
        
        export_to_kml(locations, output_path)
        
        return send_file(
            output_path,
            mimetype='application/vnd.google-earth.kml+xml',
            as_attachment=True,
            download_name=filename
        )
    finally:
        session.close()
@app.route('/export/gpkg', methods=['GET'])
def export_gpkg():
    """Export visible locations as GeoPackage."""
    session = get_session(engine)
    try:
        query = session.query(Location).filter_by(is_visible=True)
        query = apply_location_filters(query, request.args)
        locations = query.all()

        # Apply tag filter client-side if needed
        tag_filter = request.args.get('tag')
        if tag_filter and tag_filter != '__no_tag__':
            locations = filter_locations_by_tag(locations, tag_filter)

        if not locations:
            return jsonify({'error': 'No visible locations to export'}), 404
        
        filename = generate_export_filename('gpkg')
        output_path = os.path.join(export_dir, filename)
        
        export_to_gpkg(locations, output_path)
        
        return send_file(
            output_path,
            mimetype='application/geopackage+sqlite3',
            as_attachment=True,
            download_name=filename
        )
    finally:
        session.close()


@app.route('/export/map-image', methods=['GET'])
def export_map_image():
    """Generate a static PNG map image with location markers and tracks."""
    from staticmap import StaticMap, CircleMarker, Line
    import io
    import json as json_mod
    from shapely.geometry import shape as shapely_shape

    session = get_session(engine)
    try:
        query = session.query(Location).filter_by(is_visible=True)
        query = apply_location_filters(query, request.args)
        locations = query.all()

        tag_filter = request.args.get('tag')
        if tag_filter and tag_filter != '__no_tag__':
            locations = filter_locations_by_tag(locations, tag_filter)

        # Fetch tracks with same filters
        track_query = session.query(Track).filter_by(is_visible=True)
        group_filter = request.args.get('group')
        if group_filter:
            track_query = track_query.filter(Track.group_name == group_filter)
        from_date = request.args.get('from_date')
        if from_date:
            try:
                from_dt = datetime.fromisoformat(from_date)
                track_query = track_query.filter(Track.timestamp >= from_dt)
            except:
                pass
        to_date = request.args.get('to_date')
        if to_date:
            try:
                to_dt = datetime.fromisoformat(to_date + 'T23:59:59')
                track_query = track_query.filter(Track.timestamp <= to_dt)
            except:
                pass
        tracks = track_query.all()

        if not locations and not tracks:
            return jsonify({'error': 'No visible locations to export'}), 404

        m = StaticMap(800, 600, url_template='https://tile.openstreetmap.org/{z}/{x}/{y}.png')
        for loc in locations:
            marker = CircleMarker((loc.longitude, loc.latitude), 'red', 10)
            m.add_marker(marker)

        for track in tracks:
            geom = shapely_shape(json_mod.loads(track.geometry_json))
            if geom.geom_type == 'LineString':
                coords = [(c[0], c[1]) for c in geom.coords]
                m.add_line(Line(coords, '#FF6B35', 3))
            elif geom.geom_type == 'MultiLineString':
                for line in geom.geoms:
                    coords = [(c[0], c[1]) for c in line.coords]
                    m.add_line(Line(coords, '#FF6B35', 3))

        image = m.render()
        buf = io.BytesIO()
        image.save(buf, format='PNG')
        buf.seek(0)

        return send_file(buf, mimetype='image/png', download_name='map.png')
    finally:
        session.close()


@app.route('/export/map-html', methods=['GET'])
def export_map_html():
    """Generate a self-contained HTML file with an interactive Leaflet map (points + tracks)."""
    import json as json_mod

    session = get_session(engine)
    try:
        query = session.query(Location).filter_by(is_visible=True)
        query = apply_location_filters(query, request.args)
        locations = query.all()

        tag_filter = request.args.get('tag')
        if tag_filter and tag_filter != '__no_tag__':
            locations = filter_locations_by_tag(locations, tag_filter)

        # Fetch tracks with same filters
        track_query = session.query(Track).filter_by(is_visible=True)
        group_filter = request.args.get('group')
        if group_filter:
            track_query = track_query.filter(Track.group_name == group_filter)
        from_date = request.args.get('from_date')
        if from_date:
            try:
                from_dt = datetime.fromisoformat(from_date)
                track_query = track_query.filter(Track.timestamp >= from_dt)
            except:
                pass
        to_date = request.args.get('to_date')
        if to_date:
            try:
                to_dt = datetime.fromisoformat(to_date + 'T23:59:59')
                track_query = track_query.filter(Track.timestamp <= to_dt)
            except:
                pass
        tracks = track_query.all()

        if not locations and not tracks:
            return jsonify({'error': 'No visible locations to export'}), 404

        points = []
        for loc in locations:
            points.append({
                'lat': loc.latitude,
                'lng': loc.longitude,
                'name': loc.name or loc.sender_name or f'Location {loc.id}',
                'sender': loc.sender_name or '',
                'time': loc.timestamp.strftime('%H:%M') if loc.timestamp else '',
                'address': loc.address or '',
            })

        track_data = []
        for t in tracks:
            track_data.append({
                'name': t.name or 'מסלול',
                'source': t.source_filename or '',
                'geometry': json_mod.loads(t.geometry_json),
            })

        points_json = json_mod.dumps(points, ensure_ascii=False)
        tracks_json = json_mod.dumps(track_data, ensure_ascii=False)
        html = f'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Map Export</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9/dist/leaflet.js"></script>
<style>html,body,#map{{margin:0;padding:0;height:100%}}</style>
</head><body>
<div id="map"></div>
<script>
var points = {points_json};
var tracks = {tracks_json};
var map = L.map('map');
L.tileLayer('https://tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png',{{
  attribution:'&copy; OpenStreetMap contributors',maxZoom:19}}).addTo(map);
var bounds = [];
points.forEach(function(p){{
  var marker = L.marker([p.lat,p.lng]).addTo(map);
  marker.bindPopup('<b>'+p.name+'</b><br>'+p.sender+'<br>'+p.time+'<br>'+p.address);
  bounds.push([p.lat,p.lng]);
}});
tracks.forEach(function(t){{
  var layer = L.geoJSON(t.geometry,{{style:{{color:'#FF6B35',weight:3,opacity:0.8}}}}).addTo(map);
  layer.bindPopup('<b>'+t.name+'</b><br>'+t.source);
  var b = layer.getBounds();
  if(b.isValid()){{bounds.push([b.getSouthWest().lat,b.getSouthWest().lng]);bounds.push([b.getNorthEast().lat,b.getNorthEast().lng]);}}
}});
if(bounds.length>0)map.fitBounds(bounds,{{padding:[30,30]}});
</script></body></html>'''

        return html, 200, {'Content-Type': 'text/html; charset=utf-8'}
    finally:
        session.close()


@app.route('/import/kml', methods=['POST'])
def import_kml():
    """Import a KML file — creates Location records for Points, Track records for LineStrings."""
    import tempfile
    import json as json_mod
    import fiona
    from shapely.geometry import shape

    try:
        data = request.get_json()
        if not data or not data.get('kml_data'):
            return jsonify({'error': 'No KML data provided'}), 400

        kml_bytes = base64.b64decode(data['kml_data'])
        filename = data.get('filename', 'import.kml')
        group_id = data.get('group_id', '')
        group_name = data.get('group_name')
        sender_id = data.get('sender_id', '')
        sender_name = data.get('sender_name')
        tags = json_mod.dumps(['kml-import', filename])

        session = get_session(engine)
        points_imported = 0
        tracks_imported = 0
        details = []

        try:
            with tempfile.NamedTemporaryFile(suffix='.kml', delete=False) as tmp:
                tmp.write(kml_bytes)
                tmp_path = tmp.name

            # KML files can have multiple layers
            for layer_name in fiona.listlayers(tmp_path):
                with fiona.open(tmp_path, layer=layer_name) as src:
                    for feature in src:
                        geom = shape(feature['geometry'])
                        props = feature.get('properties', {})
                        feat_name = props.get('Name') or props.get('name') or ''
                        feat_desc = props.get('Description') or props.get('description') or ''

                        if geom.geom_type == 'Point':
                            loc = Location(
                                message_id=f"kml-import-{uuid.uuid4().hex[:12]}",
                                latitude=geom.y,
                                longitude=geom.x,
                                name=feat_name or None,
                                address=feat_desc or None,
                                group_id=group_id,
                                group_name=group_name,
                                sender_id=sender_id,
                                sender_name=sender_name,
                                timestamp=datetime.utcnow(),
                                tags_json=tags,
                                report_text=f"Imported from {filename}",
                            )
                            session.add(loc)
                            points_imported += 1
                            details.append(f"Point: {feat_name or 'unnamed'}")

                        elif geom.geom_type in ('LineString', 'MultiLineString'):
                            track = Track(
                                track_id=f"kml-import-{uuid.uuid4().hex[:12]}",
                                name=feat_name or None,
                                description=feat_desc or None,
                                geometry_json=json_mod.dumps(geom.__geo_interface__),
                                group_id=group_id,
                                group_name=group_name,
                                sender_id=sender_id,
                                sender_name=sender_name,
                                timestamp=datetime.utcnow(),
                                source_filename=filename,
                                tags_json=tags,
                            )
                            session.add(track)
                            tracks_imported += 1
                            details.append(f"Track: {feat_name or 'unnamed'}")

            session.commit()

            # Clean up temp file
            os.unlink(tmp_path)

            app.logger.info(f"KML import: {points_imported} points, {tracks_imported} tracks from {filename}")
            return jsonify({
                'status': 'success',
                'points_imported': points_imported,
                'tracks_imported': tracks_imported,
                'details': details,
            }), 201

        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()

    except Exception as e:
        app.logger.error(f"Error importing KML: {str(e)}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/tags', methods=['GET'])
def get_tags():
    """Get all unique tags used in reports."""
    session = get_session(engine)
    try:
        reports = session.query(Report).filter(Report.tags_json.isnot(None)).all()
        all_tags = set()
        for report in reports:
            tags = report.get_tags()
            all_tags.update(tags)
        return jsonify({
            'tags': sorted(list(all_tags))
        })
    finally:
        session.close()


@app.route('/stats', methods=['GET'])
def get_stats():
    """Get statistics about stored data."""
    session = get_session(engine)
    try:
        message_count = session.query(Message).count()
        location_count = session.query(Location).count()
        report_count = session.query(Report).count()
        complete_reports = session.query(Report).filter_by(status='complete').count()
        invalid_reports = session.query(Report).filter_by(status='invalid').count()

        # Get unique groups
        groups = session.query(Message.group_id, Message.group_name).distinct().all()
        
        return jsonify({
            'messages': message_count,
            'locations': location_count,
            'reports': {
                'total': report_count,
                'complete': complete_reports,
                'invalid': invalid_reports
            },
            'groups': [{'id': g[0], 'name': g[1]} for g in groups]
        })
    finally:
        session.close()


@app.route('/dashboard')
def dashboard():
    """Serve the dashboard page."""
    return send_file('static/index.html')


@app.route('/api/geojson', methods=['GET'])
def api_geojson():
    """Live GeoJSON API for the dashboard (points + tracks)."""
    import json as json_mod
    session = get_session(engine)
    try:
        locations = session.query(Location).order_by(Location.timestamp.desc()).all()

        features = []
        for loc in locations:
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [loc.longitude, loc.latitude]
                },
                "properties": loc.to_dict()
            })

        # Include tracks as LineString/MultiLineString features
        tracks = session.query(Track).order_by(Track.timestamp.desc()).all()
        for track in tracks:
            props = track.to_dict()
            props['_type'] = 'track'
            features.append({
                "type": "Feature",
                "geometry": json_mod.loads(track.geometry_json),
                "properties": props
            })

        return jsonify({
            "type": "FeatureCollection",
            "features": features
        })
    finally:
        session.close()


# ===== Service Management =====
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
service_manager = ServiceManager(project_root)


def migrate_config_groups():
    """Migrate target_groups from config.yaml to database on first run."""
    session = get_session(engine)
    try:
        existing = session.query(ListenerGroup).count()
        if existing > 0:
            return  # Already migrated

        whatsapp_groups = config.get('whatsapp', {}).get('target_groups', [])
        for group in whatsapp_groups:
            lg = ListenerGroup(
                platform='whatsapp',
                group_id=group['id'],
                group_name=group['name'],
                is_active=True,
                is_dm=False,
            )
            session.add(lg)

        if whatsapp_groups:
            session.commit()
            print(f"Migrated {len(whatsapp_groups)} WhatsApp groups from config.yaml to database")
    except Exception as e:
        session.rollback()
        print(f"Error migrating groups: {e}")
    finally:
        session.close()


@app.route('/management')
def management_page():
    return send_from_directory(app.static_folder, 'management.html')


@app.route('/api/services', methods=['GET'])
def get_services():
    return jsonify({'services': service_manager.status_all()})


@app.route('/api/services/<name>/start', methods=['POST'])
def start_service(name):
    result = service_manager.start(name)
    status_code = 200 if 'error' not in result else 400
    return jsonify(result), status_code


@app.route('/api/services/<name>/stop', methods=['POST'])
def stop_service(name):
    result = service_manager.stop(name)
    return jsonify(result)


@app.route('/api/services/<name>/auth', methods=['GET'])
def get_service_auth(name):
    return jsonify(service_manager.get_auth(name))


@app.route('/api/services/<name>/auth', methods=['POST'])
def update_service_auth(name):
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400
    service_manager.update_auth(name, data)
    return jsonify({'status': 'ok'})


@app.route('/api/services/telegram/token', methods=['POST'])
def save_telegram_token():
    data = request.get_json()
    token = data.get('token', '').strip() if data else ''
    if not token:
        return jsonify({'error': 'Token is required'}), 400
    if service_manager.save_telegram_token(token):
        return jsonify({'status': 'saved'})
    return jsonify({'error': 'Failed to save token'}), 500


@app.route('/api/services/<name>/logs', methods=['GET'])
def get_service_logs(name):
    lines = request.args.get('lines', 100, type=int)
    logs = service_manager.get_logs(name, lines)
    return jsonify({'logs': logs, 'service': name})


# ===== Group Configuration CRUD =====

@app.route('/api/groups', methods=['GET'])
def get_groups():
    session = get_session(engine)
    try:
        query = session.query(ListenerGroup)
        platform = request.args.get('platform')
        if platform:
            query = query.filter(ListenerGroup.platform == platform)
        groups = query.order_by(ListenerGroup.platform, ListenerGroup.group_name).all()
        return jsonify({'groups': [g.to_dict() for g in groups]})
    finally:
        session.close()


@app.route('/api/groups', methods=['POST'])
def create_group():
    data = request.get_json()
    if not data or not data.get('platform') or not data.get('group_id'):
        return jsonify({'error': 'platform and group_id are required'}), 400

    session = get_session(engine)
    try:
        # Check for duplicate
        existing = session.query(ListenerGroup).filter_by(
            platform=data['platform'],
            group_id=data['group_id']
        ).first()
        if existing:
            return jsonify({'error': 'Group already exists', 'group': existing.to_dict()}), 409

        group = ListenerGroup(
            platform=data['platform'],
            group_id=data['group_id'],
            group_name=data.get('group_name', ''),
            is_active=data.get('is_active', True),
            is_dm=data.get('is_dm', False),
        )
        session.add(group)
        session.commit()
        return jsonify({'status': 'created', 'group': group.to_dict()}), 201
    except Exception as e:
        session.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        session.close()


@app.route('/api/groups/<int:group_id>', methods=['PATCH'])
def update_group(group_id):
    data = request.get_json()
    session = get_session(engine)
    try:
        group = session.query(ListenerGroup).get(group_id)
        if not group:
            return jsonify({'error': 'Group not found'}), 404

        if 'is_active' in data:
            group.is_active = data['is_active']
        if 'group_name' in data:
            group.group_name = data['group_name']
        if 'is_dm' in data:
            group.is_dm = data['is_dm']

        session.commit()
        return jsonify({'status': 'updated', 'group': group.to_dict()})
    except Exception as e:
        session.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        session.close()


@app.route('/api/groups/<int:group_id>', methods=['DELETE'])
def delete_group(group_id):
    session = get_session(engine)
    try:
        group = session.query(ListenerGroup).get(group_id)
        if not group:
            return jsonify({'error': 'Group not found'}), 404

        session.delete(group)
        session.commit()
        return jsonify({'status': 'deleted'})
    except Exception as e:
        session.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        session.close()


import atexit

def cleanup_services():
    service_manager.stop_all()

atexit.register(cleanup_services)


if __name__ == '__main__':
    host = config['python_service']['host']
    port = config['python_service']['port']

    # Migrate config.yaml groups to database on first run
    migrate_config_groups()

    # Ensure export directory exists
    if not os.path.exists(export_dir):
        os.makedirs(export_dir, exist_ok=True)

    print(f"Starting GIS Processor on http://{host}:{port}")
    print(f"Dashboard: http://{host}:{port}/dashboard")
    print(f"Management: http://{host}:{port}/management")
    print(f"Database: {database_url}")

    app.run(host=host, port=port, debug=False)
