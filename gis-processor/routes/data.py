"""
Blueprint for data ingestion and CRUD routes.

Handles:
  POST /message, POST /report
  GET  /messages, /locations, /reports, /reports/<id>
  PATCH/DELETE /api/reports/<id>
  PATCH/DELETE /api/locations/<id>
"""
import os
import base64
import uuid
from datetime import datetime

from flask import Blueprint, request, jsonify, current_app

from models import Message, Location, Report, get_session

data_bp = Blueprint('data', __name__)


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def save_media_from_data(data: dict) -> str | None:
    """Save base64 media data to disk and return the relative path."""
    if not data.get('mediaData'):
        return None

    try:
        media_dir = current_app.config['MEDIA_DIR']
        media_data = base64.b64decode(data['mediaData'])
        filename = f"{uuid.uuid4()}_{data.get('mediaFilename', 'image.jpg')}"
        file_path = os.path.join(media_dir, filename)

        with open(file_path, 'wb') as f:
            f.write(media_data)

        return os.path.join('data', 'media', filename)
    except Exception as e:
        current_app.logger.error(f"Error saving media: {str(e)}")
        return None


def apply_location_filters(query, args):
    """Apply filter parameters to a Location query."""
    import json  # noqa: F401 — kept for symmetry with original

    current_app.logger.info(f"Applying filters: {dict(args)}")

    # Date filters
    from_date = args.get('from_date')
    to_date = args.get('to_date')
    if from_date:
        try:
            from_dt = datetime.fromisoformat(from_date)
            query = query.filter(Location.timestamp >= from_dt)
            current_app.logger.info(f"Applied from_date filter: {from_dt}")
        except Exception as e:
            current_app.logger.warning(f"Failed to parse from_date: {e}")
    if to_date:
        try:
            to_dt = datetime.fromisoformat(to_date + 'T23:59:59')
            query = query.filter(Location.timestamp <= to_dt)
            current_app.logger.info(f"Applied to_date filter: {to_dt}")
        except Exception as e:
            current_app.logger.warning(f"Failed to parse to_date: {e}")

    # Tag filter — only handle "no tag" filter in SQL;
    # specific tag filtering is done client-side after fetching.
    tag_filter = args.get('tag')
    if tag_filter and tag_filter == '__no_tag__':
        query = query.filter(Location.tags_json.is_(None))
        current_app.logger.info("Applied no_tag filter")

    # Group filter
    group = args.get('group')
    if group:
        query = query.filter(Location.group_name == group)
        current_app.logger.info(f"Applied group filter: {group}")

    return query


def filter_locations_by_tag(locations: list, tag: str) -> list:
    """Filter locations by tag (client-side filtering for JSON arrays)."""
    filtered = []
    for loc in locations:
        tags = loc.get_tags()
        if tag in tags:
            filtered.append(loc)
    return filtered


# ---------------------------------------------------------------------------
# Data ingestion
# ---------------------------------------------------------------------------

@data_bp.route('/message', methods=['POST'])
def receive_message():
    """Receive a message from the WhatsApp listener."""
    try:
        data = request.get_json()

        if not data:
            return jsonify({'error': 'No data provided'}), 400

        engine = current_app.config['ENGINE']
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
                except (ValueError, TypeError, OSError):
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

            current_app.logger.info(
                f"Stored message: {data.get('id')} (type: {data.get('messageType')})"
            )

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
        current_app.logger.error(f"Error processing message: {str(e)}")
        return jsonify({'error': str(e)}), 500


@data_bp.route('/report', methods=['POST'])
def receive_report():
    """Receive a report from the WhatsApp listener (messages between תד and סד)."""
    try:
        data = request.get_json()

        if not data:
            return jsonify({'error': 'No data provided'}), 400

        engine = current_app.config['ENGINE']
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
                except (ValueError, TypeError, OSError):
                    started_at = datetime.utcnow()
            if data.get('endedAt'):
                try:
                    ended_at = datetime.fromtimestamp(data['endedAt'])
                except (ValueError, TypeError, OSError):
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

            # Also store location in locations table for GIS export.
            # DEDUPLICATION: Check if this location (message_id = report_id) exists already.
            existing_loc = session.query(Location).filter_by(message_id=report_id).first()

            if (
                not existing_loc
                and location_data
                and location_data.get('latitude')
                and location_data.get('longitude')
            ):
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
                current_app.logger.info(
                    f"Stored complete report: {report_id} ({report.message_count} messages)"
                )
            else:
                current_app.logger.warning(
                    f"Stored invalid report (no location): {report_id}"
                )

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
        current_app.logger.error(f"Error processing report: {str(e)}")
        return jsonify({'error': str(e)}), 500


# ---------------------------------------------------------------------------
# Listing endpoints
# ---------------------------------------------------------------------------

@data_bp.route('/messages', methods=['GET'])
def list_messages():
    """List all stored messages."""
    engine = current_app.config['ENGINE']
    session = get_session(engine)
    try:
        messages = session.query(Message).order_by(Message.timestamp.desc()).limit(100).all()
        return jsonify({
            'count': len(messages),
            'messages': [msg.to_dict() for msg in messages]
        })
    finally:
        session.close()


@data_bp.route('/locations', methods=['GET'])
def list_locations():
    """List all stored locations. Supports optional group and from_date/to_date filters."""
    engine = current_app.config['ENGINE']
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


@data_bp.route('/reports', methods=['GET'])
def list_reports():
    """List all stored reports."""
    engine = current_app.config['ENGINE']
    session = get_session(engine)
    try:
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


@data_bp.route('/reports/<report_id>', methods=['GET'])
def get_report(report_id):
    """Get a specific report by ID."""
    engine = current_app.config['ENGINE']
    session = get_session(engine)
    try:
        report = session.query(Report).filter_by(report_id=report_id).first()

        if not report:
            return jsonify({'error': 'Report not found'}), 404

        return jsonify(report.to_dict())
    finally:
        session.close()


# ---------------------------------------------------------------------------
# Report CRUD
# ---------------------------------------------------------------------------

@data_bp.route('/api/reports/<report_id>', methods=['PATCH'])
def update_report(report_id):
    """Update report properties (visibility, tag, etc.)."""
    engine = current_app.config['ENGINE']
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


@data_bp.route('/api/reports/<report_id>', methods=['DELETE'])
def delete_report(report_id):
    """Delete a report and its associated location."""
    engine = current_app.config['ENGINE']
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


# ---------------------------------------------------------------------------
# Location CRUD
# ---------------------------------------------------------------------------

@data_bp.route('/api/locations/<int:loc_id>', methods=['PATCH'])
def toggle_location_visibility(loc_id):
    """Toggle the visibility of a specific location."""
    engine = current_app.config['ENGINE']
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


@data_bp.route('/api/locations/<int:loc_id>', methods=['DELETE'])
def delete_location(loc_id):
    """Delete a specific location."""
    engine = current_app.config['ENGINE']
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
