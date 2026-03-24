"""
Blueprint for GIS export and import routes.

Handles:
  GET  /export/geojson
  GET  /export/reports/geojson
  GET  /export/shapefile
  GET  /export/kml
  GET  /export/gpkg
  GET  /api/map-styles
  GET  /export/map-image
  GET  /export/map-html
  POST /import/kml
"""
import os
import base64
import uuid
from datetime import datetime

from flask import Blueprint, request, jsonify, send_file, current_app

from models import Location, Report, Track, get_session
from gis_export import (
    export_to_geojson,
    export_to_shapefile,
    export_to_kml,
    export_to_gpkg,
    generate_export_filename,
    export_reports_to_geojson,
)
from routes.data import apply_location_filters, filter_locations_by_tag

export_bp = Blueprint('export', __name__)

MAP_STYLES = {
    'street': {
        'name': 'Street',
        'name_he': 'רחובות',
        'url': 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    },
    'satellite': {
        'name': 'Satellite',
        'name_he': 'לוויין',
        'url': 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    },
    'topo': {
        'name': 'Topographic',
        'name_he': 'טופוגרפי',
        'url': 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    },
    'dark': {
        'name': 'Dark',
        'name_he': 'כהה',
        'url': 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}.png',
    },
    'terrain': {
        'name': 'Terrain',
        'name_he': 'שטח',
        'url': 'https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}.png',
    },
}


# ---------------------------------------------------------------------------
# GIS exports
# ---------------------------------------------------------------------------

@export_bp.route('/export/geojson', methods=['GET'])
def export_geojson():
    """Export visible locations as GeoJSON."""
    engine = current_app.config['ENGINE']
    export_dir = current_app.config['EXPORT_DIR']
    session = get_session(engine)
    try:
        # Check if we should export only report locations
        reports_only = request.args.get('reports_only', 'false').lower() == 'true'

        # Start with base query
        query = session.query(Location).filter_by(is_visible=True)
        base_count = query.count()
        current_app.logger.info(f"Base visible locations count: {base_count}")

        if reports_only:
            query = query.filter(Location.report_id.isnot(None))
            current_app.logger.info(f"After reports_only filter: {query.count()}")

        # Apply additional filters
        query = apply_location_filters(query, request.args)
        locations = query.all()

        # Apply tag filter client-side if needed
        tag_filter = request.args.get('tag')
        if tag_filter and tag_filter != '__no_tag__':
            locations = filter_locations_by_tag(locations, tag_filter)
            current_app.logger.info(f"After tag filter '{tag_filter}': {len(locations)} locations")

        current_app.logger.info(f"Final filtered locations count: {len(locations)}")

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


@export_bp.route('/export/reports/geojson', methods=['GET'])
def export_reports_geojson():
    """Export visible complete reports as GeoJSON."""
    engine = current_app.config['ENGINE']
    export_dir = current_app.config['EXPORT_DIR']
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


@export_bp.route('/export/shapefile', methods=['GET'])
def export_shapefile():
    """Export visible locations as Shapefile (ZIP)."""
    engine = current_app.config['ENGINE']
    export_dir = current_app.config['EXPORT_DIR']
    session = get_session(engine)
    try:
        query = session.query(Location).filter_by(is_visible=True)
        query = apply_location_filters(query, request.args)
        locations = query.all()

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


@export_bp.route('/export/kml', methods=['GET'])
def export_kml():
    """Export visible locations as KML (Google Earth)."""
    engine = current_app.config['ENGINE']
    export_dir = current_app.config['EXPORT_DIR']
    session = get_session(engine)
    try:
        query = session.query(Location).filter_by(is_visible=True)
        query = apply_location_filters(query, request.args)
        locations = query.all()

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


@export_bp.route('/export/gpkg', methods=['GET'])
def export_gpkg():
    """Export visible locations as GeoPackage."""
    engine = current_app.config['ENGINE']
    export_dir = current_app.config['EXPORT_DIR']
    session = get_session(engine)
    try:
        query = session.query(Location).filter_by(is_visible=True)
        query = apply_location_filters(query, request.args)
        locations = query.all()

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


# ---------------------------------------------------------------------------
# Map styles
# ---------------------------------------------------------------------------

@export_bp.route('/api/map-styles', methods=['GET'])
def get_map_styles():
    return jsonify({'styles': {k: {'name': v['name'], 'name_he': v['name_he']} for k, v in MAP_STYLES.items()}})


# ---------------------------------------------------------------------------
# Map image / HTML exports
# ---------------------------------------------------------------------------

@export_bp.route('/export/map-image', methods=['GET'])
def export_map_image():
    """Generate a static PNG map image with location markers and tracks."""
    from staticmap import StaticMap, CircleMarker, Line
    import io
    import json as json_mod
    from shapely.geometry import shape as shapely_shape

    engine = current_app.config['ENGINE']
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
            except (ValueError, TypeError, OSError):
                pass
        to_date = request.args.get('to_date')
        if to_date:
            try:
                to_dt = datetime.fromisoformat(to_date + 'T23:59:59')
                track_query = track_query.filter(Track.timestamp <= to_dt)
            except (ValueError, TypeError, OSError):
                pass
        tracks = track_query.all()

        if not locations and not tracks:
            return jsonify({'error': 'No visible locations to export'}), 404

        style_key = request.args.get('style', 'street')
        tile_url = MAP_STYLES.get(style_key, MAP_STYLES['street'])['url']
        m = StaticMap(800, 600, url_template=tile_url)
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


@export_bp.route('/export/map-html', methods=['GET'])
def export_map_html():
    """Generate a self-contained HTML file with an interactive Leaflet map (points + tracks)."""
    import json as json_mod

    engine = current_app.config['ENGINE']
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
            except (ValueError, TypeError, OSError):
                pass
        to_date = request.args.get('to_date')
        if to_date:
            try:
                to_dt = datetime.fromisoformat(to_date + 'T23:59:59')
                track_query = track_query.filter(Track.timestamp <= to_dt)
            except (ValueError, TypeError, OSError):
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


# ---------------------------------------------------------------------------
# KML import
# ---------------------------------------------------------------------------

@export_bp.route('/import/kml', methods=['POST'])
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

        engine = current_app.config['ENGINE']
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
                            from models import Track as TrackModel
                            track = TrackModel(
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

            current_app.logger.info(
                f"KML import: {points_imported} points, {tracks_imported} tracks from {filename}"
            )
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
        current_app.logger.error(f"Error importing KML: {str(e)}")
        return jsonify({'error': str(e)}), 500
