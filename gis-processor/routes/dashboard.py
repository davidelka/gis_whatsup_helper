"""
Blueprint for dashboard and live data API routes.

Handles:
  GET /dashboard
  GET /api/geojson
  GET /api/tags
  GET /stats
"""
import json as json_mod

from flask import Blueprint, jsonify, send_file, current_app

from models import Message, Location, Report, Track, get_session

dashboard_bp = Blueprint('dashboard', __name__)


@dashboard_bp.route('/dashboard')
def dashboard():
    """Serve the dashboard page."""
    return send_file('static/index.html')


@dashboard_bp.route('/api/geojson', methods=['GET'])
def api_geojson():
    """Live GeoJSON API for the dashboard (points + tracks)."""
    engine = current_app.config['ENGINE']
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


@dashboard_bp.route('/api/tags', methods=['GET'])
def get_tags():
    """Get all unique tags used in reports."""
    engine = current_app.config['ENGINE']
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


@dashboard_bp.route('/stats', methods=['GET'])
def get_stats():
    """Get statistics about stored data."""
    engine = current_app.config['ENGINE']
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
