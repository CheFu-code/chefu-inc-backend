import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("run-synapse.py")
SPEC = importlib.util.spec_from_file_location("run_synapse", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
run_synapse = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run_synapse)


class DatabaseConfigTests(unittest.TestCase):
    def test_parses_tls_postgres_url_and_decodes_credentials(self):
        config = run_synapse.database_config(
            "postgresql://nook:p%40ss%3Aword@db.internal:5433/synapse?sslmode=verify-full"
        )

        self.assertEqual(config["name"], "psycopg2")
        self.assertEqual(config["args"]["user"], "nook")
        self.assertEqual(config["args"]["password"], "p@ss:word")
        self.assertEqual(config["args"]["database"], "synapse")
        self.assertEqual(config["args"]["host"], "db.internal")
        self.assertEqual(config["args"]["port"], 5433)
        self.assertEqual(config["args"]["sslmode"], "verify-full")
        self.assertEqual(config["args"]["cp_max"], 8)

    def test_defaults_to_required_tls(self):
        config = run_synapse.database_config(
            "postgres://nook:secret@db.internal/synapse"
        )

        self.assertEqual(config["args"]["sslmode"], "require")

    def test_rejects_non_tls_database_connections(self):
        with self.assertRaisesRegex(RuntimeError, "require PostgreSQL TLS"):
            run_synapse.database_config(
                "postgres://nook:secret@db.internal/synapse?sslmode=disable"
            )

    def test_rejects_missing_database_credentials(self):
        with self.assertRaisesRegex(RuntimeError, "database, host, user, and password"):
            run_synapse.database_config("postgres://nook@db.internal/synapse")

    def test_rejects_unrecognized_connection_options(self):
        with self.assertRaisesRegex(RuntimeError, "unsupported query parameters"):
            run_synapse.database_config(
                "postgres://nook:secret@db.internal/synapse?sslmode=require&options=-c"
            )

    def test_rejects_repeated_ssl_mode(self):
        with self.assertRaisesRegex(RuntimeError, "must not repeat query parameters"):
            run_synapse.database_config(
                "postgres://nook:secret@db.internal/synapse?sslmode=require&sslmode=disable"
            )


class SsoWhitelistTests(unittest.TestCase):
    def test_accepts_exact_web_origin_and_mobile_callback(self):
        self.assertEqual(
            run_synapse.sso_client_whitelist("https://nook.chefu.co.za/"),
            [
                "nook://matrix-login",
                "https://nook.chefu.co.za/matrix-login",
            ],
        )

    def test_rejects_non_https_and_path_origins(self):
        for origin in ("http://nook.chefu.co.za", "https://nook.chefu.co.za/path"):
            with self.subTest(origin=origin):
                with self.assertRaisesRegex(RuntimeError, "HTTPS origin"):
                    run_synapse.sso_client_whitelist(origin)


class OidcProviderConfigTests(unittest.TestCase):
    def test_only_the_chefu_oidc_provider_enables_first_login_registration(self):
        config = SCRIPT.with_name("synapse.yaml").read_text(encoding="utf-8")
        provider_start = config.index("  - idp_id: chefu")
        provider_end = config.find("\n  - idp_id:", provider_start + 1)
        provider_config = config[provider_start:provider_end if provider_end >= 0 else None]

        self.assertIn("\n    enable_registration: true\n", provider_config)
        self.assertIn("\nenable_registration: false\n", config)


if __name__ == "__main__":
    unittest.main()
