#!/usr/bin/env python3
import os
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Required environment variable {name} is not configured.")
    return value


def database_config(database_url: str) -> dict:
    parsed = urlsplit(database_url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("SYNAPSE_DATABASE_URL must use postgres:// or postgresql://.")
    database_name = unquote(parsed.path.strip("/"))
    if (
        not parsed.hostname
        or not database_name
        or "/" in database_name
        or not parsed.username
        or not parsed.password
    ):
        raise RuntimeError("SYNAPSE_DATABASE_URL must include a database, host, user, and password.")

    query = parse_qs(parsed.query)
    if any(len(values) != 1 for values in query.values()):
        raise RuntimeError("SYNAPSE_DATABASE_URL must not repeat query parameters.")
    if set(query) - {"sslmode"}:
        raise RuntimeError("SYNAPSE_DATABASE_URL contains unsupported query parameters.")
    if parsed.fragment:
        raise RuntimeError("SYNAPSE_DATABASE_URL must not contain a fragment.")
    sslmode = query.get("sslmode", ["require"])[0]
    if sslmode not in {"require", "verify-ca", "verify-full"}:
        raise RuntimeError("SYNAPSE_DATABASE_URL must require PostgreSQL TLS.")

    return {
        "name": "psycopg2",
        "args": {
            "user": unquote(parsed.username),
            "password": unquote(parsed.password or ""),
            "database": database_name,
            "host": parsed.hostname,
            "port": parsed.port or 5432,
            "sslmode": sslmode,
            "cp_min": 3,
            "cp_max": 8,
        },
    }


def sso_client_whitelist(web_origin: str) -> list[str]:
    normalized_origin = web_origin.strip().rstrip("/")
    parsed_origin = urlsplit(normalized_origin)
    if (
        parsed_origin.scheme != "https"
        or not parsed_origin.netloc
        or parsed_origin.username
        or parsed_origin.password
        or parsed_origin.path
        or parsed_origin.query
        or parsed_origin.fragment
    ):
        raise RuntimeError("SYNAPSE_WEB_ORIGIN must be an HTTPS origin without a path.")

    return ["nook://matrix-login", f"{normalized_origin}/matrix-login"]


def main() -> None:
    import grp
    import pwd
    import yaml

    data_dir = Path("/data")
    data_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
    synapse_user = None
    if os.geteuid() == 0:
        synapse_user = pwd.getpwuid(991)
        synapse_group = grp.getgrgid(synapse_user.pw_gid)
        os.chown(data_dir, synapse_user.pw_uid, synapse_group.gr_gid)

    config = yaml.safe_load(Path("/etc/nook-matrix/synapse.yaml").read_text(encoding="utf-8"))
    config["database"] = database_config(required_env("SYNAPSE_DATABASE_URL"))

    config["sso"]["client_whitelist"] = sso_client_whitelist(
        required_env("SYNAPSE_WEB_ORIGIN")
    )

    config_path = Path("/tmp/nook-homeserver.yaml")
    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    config_path.chmod(0o640)
    if os.geteuid() == 0 and synapse_user is not None:
        os.chown(config_path, synapse_user.pw_uid, synapse_user.pw_gid)

    os.execv("/start.py", ["/start.py", "run", f"--config-path={config_path}"])


if __name__ == "__main__":
    main()
