"""Tests for configuration validation.

These tests verify transport mutual exclusivity, BLE PIN requirement,
and connection_type derivation.
"""

import logging

import pytest
from pydantic import ValidationError

from app.config import Settings, setup_logging


def test_sql_debug_parameters_are_suppressed():
    """Database-bound values must not leak when application DEBUG logging is enabled."""
    setup_logging()

    assert logging.getLogger("aiosqlite").getEffectiveLevel() == logging.WARNING


def test_meshcore_debug_message_payloads_are_suppressed(caplog):
    """Dependency debug logs must not expose chat or CLI text."""
    setup_logging()
    sentinel = "PRIVATE-SENTINEL-meshcore-debug-31d8"
    caplog.set_level(logging.DEBUG, logger="meshcore")

    dependency_logger = logging.getLogger("meshcore")
    dependency_logger.addHandler(caplog.handler)
    try:
        dependency_logger.debug("Sending message to aabbcc: %s", sentinel)
        dependency_logger.debug("Sending channel message to channel 3: %s", sentinel)
        dependency_logger.debug("Sending command to aabbcc: %s", sentinel)
        dependency_logger.debug("Requesting pending messages")
    finally:
        dependency_logger.removeHandler(caplog.handler)

    captured = "\n".join(record.getMessage() for record in caplog.records)
    assert sentinel not in captured
    assert "Requesting pending messages" in captured


class TestTransportExclusivity:
    """Ensure only one transport can be configured at a time."""

    def test_no_transport_defaults_to_serial(self):
        """No transport env vars means serial auto-detect."""
        s = Settings(serial_port="", tcp_host="", ble_address="")
        assert s.connection_type == "serial"

    def test_serial_only(self):
        s = Settings(serial_port="/dev/ttyUSB0")
        assert s.connection_type == "serial"

    def test_tcp_only(self):
        s = Settings(tcp_host="192.168.1.1")
        assert s.connection_type == "tcp"

    def test_tcp_with_custom_port(self):
        s = Settings(tcp_host="192.168.1.1", tcp_port=5000)
        assert s.connection_type == "tcp"
        assert s.tcp_port == 5000

    def test_tcp_default_port(self):
        s = Settings(tcp_host="192.168.1.1")
        assert s.tcp_port == 5000

    def test_ble_only(self):
        s = Settings(ble_address="AA:BB:CC:DD:EE:FF", ble_pin="123456")
        assert s.connection_type == "ble"

    def test_serial_and_tcp_rejected(self):
        with pytest.raises(ValidationError, match="Only one transport"):
            Settings(serial_port="/dev/ttyUSB0", tcp_host="192.168.1.1")

    def test_serial_and_ble_rejected(self):
        with pytest.raises(ValidationError, match="Only one transport"):
            Settings(
                serial_port="/dev/ttyUSB0",
                ble_address="AA:BB:CC:DD:EE:FF",
                ble_pin="123456",
            )

    def test_tcp_and_ble_rejected(self):
        with pytest.raises(ValidationError, match="Only one transport"):
            Settings(
                tcp_host="192.168.1.1",
                ble_address="AA:BB:CC:DD:EE:FF",
                ble_pin="123456",
            )

    def test_all_three_rejected(self):
        with pytest.raises(ValidationError, match="Only one transport"):
            Settings(
                serial_port="/dev/ttyUSB0",
                tcp_host="192.168.1.1",
                ble_address="AA:BB:CC:DD:EE:FF",
                ble_pin="123456",
            )


class TestBLEPinRequirement:
    """BLE address requires a PIN."""

    def test_ble_address_without_pin_rejected(self):
        with pytest.raises(ValidationError, match="MESHCORE_BLE_PIN is required"):
            Settings(ble_address="AA:BB:CC:DD:EE:FF", ble_pin="")

    def test_ble_address_with_pin_accepted(self):
        s = Settings(ble_address="AA:BB:CC:DD:EE:FF", ble_pin="123456")
        assert s.ble_address == "AA:BB:CC:DD:EE:FF"
        assert s.ble_pin == "123456"


class TestBasicAuthConfiguration:
    """Ensure basic auth credentials are configured as a pair."""

    def test_basic_auth_disabled_by_default(self):
        s = Settings(serial_port="", tcp_host="", ble_address="")
        assert s.basic_auth_enabled is False

    def test_basic_auth_enabled_when_both_credentials_are_set(self):
        s = Settings(
            serial_port="",
            tcp_host="",
            ble_address="",
            basic_auth_username="mesh",
            basic_auth_password="secret",
        )
        assert s.basic_auth_enabled is True

    def test_basic_auth_requires_password_with_username(self):
        with pytest.raises(ValidationError, match="MESHCORE_BASIC_AUTH_USERNAME"):
            Settings(
                serial_port="",
                tcp_host="",
                ble_address="",
                basic_auth_username="mesh",
                basic_auth_password="",
            )

    def test_basic_auth_requires_username_with_password(self):
        with pytest.raises(ValidationError, match="MESHCORE_BASIC_AUTH_USERNAME"):
            Settings(
                serial_port="",
                tcp_host="",
                ble_address="",
                basic_auth_username="",
                basic_auth_password="secret",
            )


class TestExperimentalAliases:
    """Ensure exact-name experimental env vars still map into settings."""

    def test_clowntown_wraparound_alias_reads_exact_env_var(self, monkeypatch):
        monkeypatch.setenv("__CLOWNTOWN_DO_CLOCK_WRAPAROUND", "true")
        s = Settings(serial_port="", tcp_host="", ble_address="")
        assert s.clowntown_do_clock_wraparound is True


class TestRadioTimeoutConfiguration:
    def test_operation_lock_timeout_is_bounded(self):
        settings = Settings(radio_operation_lock_timeout_seconds=7.5)
        assert settings.radio_operation_lock_timeout_seconds == 7.5

        with pytest.raises(ValidationError):
            Settings(radio_operation_lock_timeout_seconds=0)

        with pytest.raises(ValidationError):
            Settings(radio_operation_lock_timeout_seconds=121)

    def test_add_contact_timeout_is_bounded(self):
        settings = Settings(radio_add_contact_timeout_seconds=12.5)
        assert settings.radio_add_contact_timeout_seconds == 12.5

        with pytest.raises(ValidationError):
            Settings(radio_add_contact_timeout_seconds=0.5)

        with pytest.raises(ValidationError):
            Settings(radio_add_contact_timeout_seconds=121)
