import unittest

import requests
from fastapi.testclient import TestClient

import gdebenz_ui.server as server


class ServerUpstreamErrorTests(unittest.TestCase):
    def test_stations_returns_json_502_when_upstream_times_out(self):
        original_get_nearby = server.api.get_nearby
        server.api.get_nearby = lambda *_args, **_kwargs: (_ for _ in ()).throw(
            requests.exceptions.ConnectTimeout("gdebenz.ru timed out")
        )
        client = TestClient(server.app, raise_server_exceptions=False)

        try:
            response = client.get(
                "/api/stations",
                params={
                    "city": "Москва",
                    "lat": 55.752,
                    "lon": 37.6178,
                    "radius": 20,
                    "offset": 0,
                    "limit": 20,
                },
            )
        finally:
            server.api.get_nearby = original_get_nearby

        self.assertEqual(response.status_code, 502)
        self.assertIn("Could not reach GdeBenz", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
