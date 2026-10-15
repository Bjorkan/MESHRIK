"""Tests for on_rx_log_data event handler (now delegates to rx_ingress)."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest


class TestOnRxLogData:
    @pytest.mark.asyncio
    async def test_extracts_hex_and_submits_to_rx_ingress(self):
        """Payload should be forwarded to the RX ingress."""
        from app.event_handlers import on_rx_log_data

        event_payload = {
            "payload": "deadbeef01020304",
            "snr": 7.5,
            "rssi": -85,
        }

        class MockEvent:
            payload = event_payload

        with patch("app.services.rx_ingress.rx_ingress.submit") as mock_submit:
            await on_rx_log_data(MockEvent())

            mock_submit.assert_called_once_with(event_payload)

    @pytest.mark.asyncio
    async def test_burst_forwards_every_distinct_packet_exactly_once(self):
        """RX ingress is lossless and is not routed through a latest-value pacer."""
        from app.event_handlers import on_rx_log_data

        events = []
        expected = []
        for index in range(100):
            raw_bytes = index.to_bytes(4, "big")
            snr = float(index % 10)
            rssi = -120 + index
            payload = {
                "payload": raw_bytes.hex(),
                "snr": snr,
                "rssi": rssi,
            }
            events.append(MagicMock(payload=payload))
            expected.append(payload)

        with patch("app.services.rx_ingress.rx_ingress.submit") as submit:
            await asyncio.gather(*(on_rx_log_data(event) for event in events))

        assert submit.call_count == len(events)
        submitted = [call.args[0] for call in submit.call_args_list]
        assert submitted == expected

    @pytest.mark.asyncio
    async def test_missing_payload_field_returns_early(self):
        """Event without 'payload' field is still submitted to rx_ingress."""
        from app.event_handlers import on_rx_log_data

        class MockEvent:
            payload = {"snr": 5.0, "rssi": -90}

        with patch("app.services.rx_ingress.rx_ingress.submit") as mock_submit:
            await on_rx_log_data(MockEvent())

            mock_submit.assert_called_once_with({"snr": 5.0, "rssi": -90})

    @pytest.mark.asyncio
    async def test_missing_snr_rssi_passes_none(self):
        """Missing SNR and RSSI fields are passed through via the dict."""
        from app.event_handlers import on_rx_log_data

        class MockEvent:
            payload = {"payload": "ff00"}

        with patch("app.services.rx_ingress.rx_ingress.submit") as mock_submit:
            await on_rx_log_data(MockEvent())

            mock_submit.assert_called_once_with({"payload": "ff00"})

    @pytest.mark.asyncio
    async def test_empty_hex_payload_produces_empty_bytes(self):
        """Empty hex string is passed through as-is."""
        from app.event_handlers import on_rx_log_data

        class MockEvent:
            payload = {"payload": ""}

        with patch("app.services.rx_ingress.rx_ingress.submit") as mock_submit:
            await on_rx_log_data(MockEvent())

            mock_submit.assert_called_once_with({"payload": ""})

    @pytest.mark.asyncio
    async def test_invalid_hex_raises_valueerror(self):
        """Invalid hex is still submitted; rx_ingress handles validation."""
        from app.event_handlers import on_rx_log_data

        class MockEvent:
            payload = {"payload": "nothex!!"}

        with patch("app.services.rx_ingress.rx_ingress.submit") as mock_submit:
            await on_rx_log_data(MockEvent())

            mock_submit.assert_called_once_with({"payload": "nothex!!"})

    @pytest.mark.asyncio
    async def test_real_meshcore_reader_forwards_3byte_log_data_to_handler(self):
        """Real meshcore reader LOG_DATA event is forwarded to rx_ingress."""
        from app.event_handlers import on_rx_log_data

        rl_payload = {
            "timestamp": 1700000000,
            "data": "00" * 10,
            "snr": 3.0,
            "rssi": -100,
            "payload_type": "ADVERT",
        }

        class MockEvent:
            payload = rl_payload

        with patch("app.services.rx_ingress.rx_ingress.submit") as mock_submit:
            await on_rx_log_data(MockEvent())

            mock_submit.assert_called_once_with(rl_payload)
