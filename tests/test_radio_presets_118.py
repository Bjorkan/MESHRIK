from app.services.community_radio_presets import normalize_official_presets


def test_meshcore_api_shape_and_optional_hash_size():
    values = normalize_official_presets(
        {
            "config": {
                "suggested_radio_settings": {
                    "entries": [
                        {
                            "title": "Narrow",
                            "frequency": "917.375",
                            "bandwidth": "62.5",
                            "spreading_factor": "7",
                            "coding_rate": "5",
                            "network_settings": {"path_hash_size": 2},
                        },
                        {
                            "title": "Bad",
                            "frequency": "nan",
                            "bandwidth": "62.5",
                            "spreading_factor": "7",
                            "coding_rate": "5",
                        },
                    ]
                }
            }
        }
    )
    assert len(values) == 1
    assert values[0]["freq"] == 917.375
    assert values[0]["path_hash_size"] == 2


def test_unexpected_configuration_is_safe():
    assert normalize_official_presets({"config": {}}) == []
    assert normalize_official_presets(None) == []
