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

from models import Message, Location, Report, init_db, get_session, get_engine
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
        # Filter by status if provided
        status_filter = request.args.get('status')
        
        query = session.query(Report).order_by(Report.started_at.desc())
        
        if status_filter:
            query = query.filter_by(status=status_filter)
        
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
def toggle_report_visibility(report_id):
    """Toggle the visibility of a report and its associated location."""
    session = get_session(engine)
    try:
        report = session.query(Report).filter_by(report_id=report_id).first()
        if not report:
            return jsonify({'error': 'Report not found'}), 404
        
        data = request.get_json()
        if 'is_visible' in data:
            new_visibility = bool(data['is_visible'])
            report.is_visible = new_visibility
            
            # Toggle visibility of ALL associated locations
            locations = session.query(Location).filter_by(report_id=report_id).all()
            for loc in locations:
                loc.is_visible = new_visibility
            
            session.commit()
            return jsonify({'status': 'success', 'is_visible': report.is_visible})
        
        return jsonify({'error': 'No visibility data provided'}), 400
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
    """List all stored locations."""
    session = get_session(engine)
    try:
        locations = session.query(Location).order_by(Location.timestamp.desc()).all()
        return jsonify({
            'count': len(locations),
            'locations': [loc.to_dict() for loc in locations]
        })
    finally:
        session.close()


@app.route('/export/geojson', methods=['GET'])
def export_geojson():
    """Export visible locations as GeoJSON."""
    session = get_session(engine)
    try:
        # Check if we should export only report locations
        reports_only = request.args.get('reports_only', 'false').lower() == 'true'
        
        query = session.query(Location).filter_by(is_visible=True)
        if reports_only:
            locations = query.filter(Location.report_id.isnot(None)).all()
        else:
            locations = query.all()
        
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
        locations = session.query(Location).filter_by(is_visible=True).all()
        
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
        locations = session.query(Location).filter_by(is_visible=True).all()
        
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
        locations = session.query(Location).filter_by(is_visible=True).all()
        
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
    """Live GeoJSON API for the dashboard."""
    session = get_session(engine)
    try:
        locations = session.query(Location).order_by(Location.timestamp.desc()).all()
        
        features = []
        for loc in locations:
            # We still include invisible ones in the API so the frontend can manage them, 
            # but frontend will decide whether to draw them.
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [loc.longitude, loc.latitude]
                },
                "properties": loc.to_dict()
            })
            
        return jsonify({
            "type": "FeatureCollection",
            "features": features
        })
    finally:
        session.close()


if __name__ == '__main__':
    host = config['python_service']['host']
    port = config['python_service']['port']
    
    print(f"🚀 Starting GIS Processor on http://{host}:{port}")
    print(f"📊 Dashboard: http://{host}:{port}/dashboard")
    print(f"📁 Database: {database_url}")
    print(f"📂 Export directory: {export_dir}")
    
    # In production, use a real WSGI server like gunicorn
    app.run(host=host, port=port, debug=False)
    print(f"")
    print(f"📋 Report commands:")
    print(f"   תד = Start report")
    print(f"   סד = End report (must include location)")
    
    # Ensure export directory exists
    if not os.path.exists(export_dir):
        os.makedirs(export_dir, exist_ok=True)
    
    app.run(host=host, port=port, debug=True)
