"""
Service manager for starting/stopping WhatsApp and Telegram listener processes.
"""
import os
import shutil
import signal
import subprocess
import time
import logging
import yaml
from pathlib import Path

logger = logging.getLogger(__name__)

SERVICES = {
    'whatsapp': {
        'name': 'WhatsApp Listener',
        'cwd': 'whatsapp-listener',
        'command': ['npm', 'run', 'dev'],
    },
    'telegram': {
        'name': 'Telegram Listener',
        'cwd': 'telegram-listener',
        'command': ['npm', 'run', 'dev'],
    },
}


class ServiceManager:
    def __init__(self, project_root: str):
        self.project_root = project_root
        self.processes: dict[str, subprocess.Popen] = {}
        self.start_times: dict[str, float] = {}
        self.log_files: dict[str, any] = {}
        self.log_dir = os.path.join(project_root, 'gis-processor', 'data', 'logs')
        os.makedirs(self.log_dir, exist_ok=True)
        self.auth_states: dict[str, dict] = {
            'whatsapp': {'status': 'disconnected', 'updated_at': 0},
            'telegram': {'status': 'disconnected', 'updated_at': 0},
        }
        # Discovered groups: { 'whatsapp': [{ id, name }], 'telegram': [{ id, name }] }
        self.discovered_groups: dict[str, list[dict]] = {
            'whatsapp': [],
            'telegram': [],
        }

    def start(self, service_name: str) -> dict:
        if service_name not in SERVICES:
            return {'error': f'Unknown service: {service_name}'}

        if self.is_running(service_name):
            return {'error': f'{service_name} is already running', 'status': 'running'}

        svc = SERVICES[service_name]
        cwd = os.path.join(self.project_root, svc['cwd'])

        if not os.path.isdir(cwd):
            return {'error': f'Service directory not found: {cwd}'}

        log_path = os.path.join(self.log_dir, f'{service_name}.log')
        log_file = open(log_path, 'a')

        try:
            proc = subprocess.Popen(
                svc['command'],
                cwd=cwd,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                preexec_fn=os.setsid,
            )
            self.processes[service_name] = proc
            self.start_times[service_name] = time.time()
            self.log_files[service_name] = log_file

            logger.info(f'Started {svc["name"]} (PID {proc.pid})')
            return {
                'status': 'started',
                'pid': proc.pid,
                'name': svc['name'],
            }
        except Exception as e:
            log_file.close()
            logger.error(f'Failed to start {service_name}: {e}')
            return {'error': str(e)}

    def stop(self, service_name: str) -> dict:
        if service_name not in SERVICES:
            return {'error': f'Unknown service: {service_name}'}

        proc = self.processes.get(service_name)
        if not proc or proc.poll() is not None:
            self.processes.pop(service_name, None)
            self.start_times.pop(service_name, None)
            return {'status': 'stopped', 'name': SERVICES[service_name]['name']}

        try:
            # Send SIGTERM to the process group
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                proc.wait(timeout=5)

            logger.info(f'Stopped {SERVICES[service_name]["name"]} (PID {proc.pid})')
        except Exception as e:
            logger.error(f'Error stopping {service_name}: {e}')
        finally:
            self.processes.pop(service_name, None)
            self.start_times.pop(service_name, None)
            log_file = self.log_files.pop(service_name, None)
            if log_file:
                try:
                    log_file.close()
                except Exception:
                    pass

        self.update_auth(service_name, {'status': 'disconnected', 'qr_data': None, 'bot_username': None})
        return {'status': 'stopped', 'name': SERVICES[service_name]['name']}

    def status(self, service_name: str) -> dict:
        if service_name not in SERVICES:
            return {'error': f'Unknown service: {service_name}'}

        svc = SERVICES[service_name]
        proc = self.processes.get(service_name)
        running = proc is not None and proc.poll() is None

        if not running and proc is not None:
            # Process exited, clean up
            self.processes.pop(service_name, None)
            self.start_times.pop(service_name, None)

        result = {
            'name': svc['name'],
            'service': service_name,
            'running': running,
        }

        if running and proc:
            result['pid'] = proc.pid
            start_time = self.start_times.get(service_name, 0)
            result['uptime_seconds'] = int(time.time() - start_time) if start_time else 0

        return result

    def status_all(self) -> list:
        return [self.status(name) for name in SERVICES]

    def is_running(self, service_name: str) -> bool:
        proc = self.processes.get(service_name)
        return proc is not None and proc.poll() is None

    def get_logs(self, service_name: str, lines: int = 100) -> str:
        log_path = os.path.join(self.log_dir, f'{service_name}.log')
        if not os.path.exists(log_path):
            return ''

        try:
            with open(log_path, 'r') as f:
                all_lines = f.readlines()
                return ''.join(all_lines[-lines:])
        except Exception:
            return ''

    def update_auth(self, service_name: str, data: dict):
        if service_name not in self.auth_states:
            self.auth_states[service_name] = {}
        self.auth_states[service_name].update(data)
        self.auth_states[service_name]['updated_at'] = time.time()

    def get_auth(self, service_name: str) -> dict:
        return self.auth_states.get(service_name, {'status': 'disconnected'})

    def save_telegram_token(self, token: str) -> bool:
        config_path = os.path.join(self.project_root, 'config.yaml')
        try:
            with open(config_path, 'r') as f:
                config = yaml.safe_load(f)

            if 'telegram' not in config:
                config['telegram'] = {}
            config['telegram']['bot_token'] = token

            with open(config_path, 'w') as f:
                yaml.dump(config, f, default_flow_style=False, allow_unicode=True)

            return True
        except Exception as e:
            logger.error(f'Failed to save Telegram token: {e}')
            return False

    def disconnect(self, service_name: str) -> dict:
        """Stop the service and clear its auth session."""
        # Stop first
        self.stop(service_name)

        cleared = []

        if service_name == 'whatsapp':
            # Remove WhatsApp auth_info directory
            auth_dir = os.path.join(self.project_root, 'whatsapp-listener', 'auth_info')
            if os.path.isdir(auth_dir):
                shutil.rmtree(auth_dir)
                cleared.append('auth_info')
            # Remove wwebjs_cache
            cache_dir = os.path.join(self.project_root, 'whatsapp-listener', '.wwebjs_cache')
            if os.path.isdir(cache_dir):
                shutil.rmtree(cache_dir)
                cleared.append('.wwebjs_cache')

        elif service_name == 'telegram':
            # Clear bot token from config
            self.save_telegram_token('YOUR_BOT_TOKEN_HERE')
            cleared.append('bot_token')

        self.update_auth(service_name, {'status': 'disconnected', 'qr_data': None, 'bot_username': None})
        logger.info(f'Disconnected {service_name}, cleared: {cleared}')
        return {'status': 'disconnected', 'cleared': cleared, 'name': SERVICES.get(service_name, {}).get('name', service_name)}

    def set_discovered_groups(self, service_name: str, groups: list[dict]):
        self.discovered_groups[service_name] = groups

    def add_discovered_group(self, service_name: str, group: dict):
        existing = self.discovered_groups.get(service_name, [])
        # Deduplicate by id
        if not any(g['id'] == group['id'] for g in existing):
            existing.append(group)
            self.discovered_groups[service_name] = existing

    def get_discovered_groups(self, service_name: str) -> list[dict]:
        return self.discovered_groups.get(service_name, [])

    def stop_all(self):
        for name in list(self.processes.keys()):
            self.stop(name)
