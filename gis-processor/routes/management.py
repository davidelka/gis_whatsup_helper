"""
Blueprint for service management and group configuration routes.

Handles:
  GET  /management
  GET  /api/services
  POST /api/services/<name>/start
  POST /api/services/<name>/stop
  POST /api/services/<name>/disconnect
  GET  /api/services/<name>/auth
  POST /api/services/<name>/auth
  POST /api/services/telegram/token
  GET  /api/services/<name>/discovered-groups
  POST /api/services/<name>/discovered-groups
  GET  /api/services/<name>/logs
  GET  /api/groups
  POST /api/groups
  PATCH/DELETE /api/groups/<id>
"""
from flask import Blueprint, request, jsonify, send_from_directory, current_app

from models import ListenerGroup, get_session

management_bp = Blueprint('management', __name__)


# ---------------------------------------------------------------------------
# Config migration helper
# ---------------------------------------------------------------------------

def migrate_config_groups() -> None:
    """Migrate target_groups from config.yaml to database on first run."""
    engine = current_app.config['ENGINE']
    config = current_app.config['CONFIG']
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


# ---------------------------------------------------------------------------
# Management page
# ---------------------------------------------------------------------------

@management_bp.route('/management')
def management_page():
    return send_from_directory(current_app.static_folder, 'management.html')


# ---------------------------------------------------------------------------
# Service management
# ---------------------------------------------------------------------------

@management_bp.route('/api/services', methods=['GET'])
def get_services():
    service_manager = current_app.config['SERVICE_MANAGER']
    return jsonify({'services': service_manager.status_all()})


@management_bp.route('/api/services/<name>/start', methods=['POST'])
def start_service(name):
    service_manager = current_app.config['SERVICE_MANAGER']
    result = service_manager.start(name)
    status_code = 200 if 'error' not in result else 400
    return jsonify(result), status_code


@management_bp.route('/api/services/<name>/stop', methods=['POST'])
def stop_service(name):
    service_manager = current_app.config['SERVICE_MANAGER']
    result = service_manager.stop(name)
    return jsonify(result)


@management_bp.route('/api/services/<name>/disconnect', methods=['POST'])
def disconnect_service(name):
    service_manager = current_app.config['SERVICE_MANAGER']
    result = service_manager.disconnect(name)
    return jsonify(result)


@management_bp.route('/api/services/<name>/auth', methods=['GET'])
def get_service_auth(name):
    service_manager = current_app.config['SERVICE_MANAGER']
    return jsonify(service_manager.get_auth(name))


@management_bp.route('/api/services/<name>/auth', methods=['POST'])
def update_service_auth(name):
    service_manager = current_app.config['SERVICE_MANAGER']
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400
    service_manager.update_auth(name, data)
    return jsonify({'status': 'ok'})


@management_bp.route('/api/services/telegram/token', methods=['POST'])
def save_telegram_token():
    service_manager = current_app.config['SERVICE_MANAGER']
    data = request.get_json()
    token = data.get('token', '').strip() if data else ''
    if not token:
        return jsonify({'error': 'Token is required'}), 400
    if service_manager.save_telegram_token(token):
        return jsonify({'status': 'saved'})
    return jsonify({'error': 'Failed to save token'}), 500


@management_bp.route('/api/services/<name>/discovered-groups', methods=['GET'])
def get_discovered_groups(name):
    service_manager = current_app.config['SERVICE_MANAGER']
    return jsonify({'groups': service_manager.get_discovered_groups(name)})


@management_bp.route('/api/services/<name>/discovered-groups', methods=['POST'])
def post_discovered_groups(name):
    service_manager = current_app.config['SERVICE_MANAGER']
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data'}), 400
    groups = data.get('groups', [])
    if groups:
        service_manager.set_discovered_groups(name, groups)
    else:
        group = data.get('group')
        if group:
            service_manager.add_discovered_group(name, group)
    return jsonify({'status': 'ok'})


@management_bp.route('/api/services/<name>/logs', methods=['GET'])
def get_service_logs(name):
    service_manager = current_app.config['SERVICE_MANAGER']
    lines = request.args.get('lines', 100, type=int)
    logs = service_manager.get_logs(name, lines)
    return jsonify({'logs': logs, 'service': name})


# ---------------------------------------------------------------------------
# Group configuration CRUD
# ---------------------------------------------------------------------------

@management_bp.route('/api/groups', methods=['GET'])
def get_groups():
    engine = current_app.config['ENGINE']
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


@management_bp.route('/api/groups', methods=['POST'])
def create_group():
    engine = current_app.config['ENGINE']
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


@management_bp.route('/api/groups/<int:group_id>', methods=['PATCH'])
def update_group(group_id):
    engine = current_app.config['ENGINE']
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


@management_bp.route('/api/groups/<int:group_id>', methods=['DELETE'])
def delete_group(group_id):
    engine = current_app.config['ENGINE']
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
