"""Frame codec, message headers, reply parsing and reassembly (ryuo_proto)."""

import hashlib
import json
import random

import pytest

import ryuo_proto as P


def unescape(frame):
    """Independent reference decoder: (len field, payload, crc) of one encoded frame."""
    assert frame[0] == 0x5A and frame[-1] == 0x5A
    body = bytearray()
    it = iter(frame[1:-1])
    for b in it:
        if b == 0x5B:
            nxt = next(it)
            assert nxt in (1, 2), "0x5B must be followed by 01 or 02"
            body.append(0x5A if nxt == 1 else 0x5B)
        else:
            assert b != 0x5A, "raw 0x5A inside a frame"
            body.append(b)
    return int.from_bytes(body[:2], "big"), bytes(body[2:-1]), body[-1]


def crc_unsigned(data):
    # Spec §7 C14: the signed-byte sum and the unsigned sum agree mod 256.
    return sum(data) & 0xFF


# ---------------------------------------------------------------- encode / decode


@pytest.mark.parametrize(
    "payload",
    [b"", b"x", b"POST conn 1\r\nSeqNumber=1\r\n\r\n{}", b"Z[Z[", bytes(range(256)), b"\xff" * 300],
)
def test_encode_layout_len_crc(payload):
    frame = P.encode(payload)
    length, inner, crc = unescape(frame)
    assert inner == payload
    assert length == len(payload) + 5
    assert crc == crc_unsigned(length.to_bytes(2, "big") + payload)


def test_encode_exactly_two_raw_5a_bytes():
    rng = random.Random(1)
    for _ in range(200):
        payload = bytes(rng.choice(b"Z[\x5a\x5b\x01\x02abc") for _ in range(rng.randrange(0, 400)))
        assert P.encode(payload).count(0x5A) == 2


def test_escape_sequences():
    assert P.encode(b"Z") == bytes([0x5A, 0x00, 0x06, 0x5B, 0x01, 0x60, 0x5A])
    frame = P.encode(b"[")
    assert frame[3:5] == b"\x5b\x02"


@pytest.mark.parametrize(("n", "byte"), [(85, 0x5A), (86, 0x5B)])
def test_length_field_is_escaped(n, byte):
    # len_be16 = n + 5 lands on 0x5A / 0x5B and must be escaped like payload bytes.
    frame = P.encode(b"a" * n)
    assert frame.count(0x5A) == 2
    assert frame[1] == 0x00
    assert frame[2:4] == (b"\x5b\x01" if byte == 0x5A else b"\x5b\x02")
    assert unescape(frame)[0] == byte


def test_crc_byte_is_escaped():
    # Find a payload whose crc is 0x5A; the trailer must then be 5B 01 5A.
    for c in range(256):
        payload = bytes([0x61, c])
        if crc_unsigned((len(payload) + 5).to_bytes(2, "big") + payload) == 0x5A:
            break
    frame = P.encode(payload)
    assert frame[-3:] == b"\x5b\x01\x5a"
    assert frame.count(0x5A) == 2


def test_crc_is_signed_byte_sum():
    payload = bytes([0x80, 0xFF, 0x7F])
    signed = sum(b - 256 if b > 127 else b for b in (8).to_bytes(2, "big") + payload) & 0xFF
    assert P.encode(payload)[-2] == signed


def test_length_is_big_endian():
    frame = P.encode(b"a" * 300)
    assert frame[1:3] == (305).to_bytes(2, "big")


def test_decode_round_trip_text():
    rng = random.Random(7)
    alphabet = 'abcZ[]{}":,°ł\r\n 0123456789'
    for _ in range(100):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randrange(0, 300)))
        assert P.decode(P.encode(text.encode())) == text


def test_decode_strips_report_padding():
    frame = P.encode(b"1 200\r\nAckNumber=2\r\n\r\n")
    assert P.decode(frame.ljust(P.REPORT_LEN, b"\x00")) == "1 200\r\nAckNumber=2\r\n\r\n"


@pytest.mark.parametrize("junk", [b"", b"\x5a\x00\x5a", b"abcdefgh", b"\x00\x00\x00"])
def test_decode_unparsed(junk):
    assert P.decode(junk).startswith("<unparsed ")


# ---------------------------------------------------------------- message()


def test_message_headers_and_body():
    frame, text = P.message("POST", "brightness", 7, {"value": 60})
    assert text == '{"value":60}'
    payload = P.decode(frame)
    head, sep, body = payload.partition("\r\n\r\n")
    assert sep and body == text
    lines = head.split("\r\n")
    assert lines[0] == "POST brightness 1"
    # The device NPEs on fewer than two header lines (handoff §Payload).
    assert len(lines) - 1 >= 2
    assert lines[1:] == ["SeqNumber=7", "ContentLength=12", "ContentType=json"]


def test_message_without_body():
    frame, text = P.message("POST", "disconn", 2)
    assert text == ""
    assert P.decode(frame) == "POST disconn 1\r\nSeqNumber=2\r\nContentLength=0\r\nContentType=json\r\n\r\n"


def test_message_non_ascii_is_json_escaped():
    frame, text = P.message("POST", "x", 1, {"u": "°C"})
    assert text == '{"u":"\\u00b0C"}'
    assert f"ContentLength={len(text.encode())}\r\n" in P.decode(frame)


def test_message_json_is_compact():
    _, text = P.message("POST", "preset", 1, {"a": [1, 2], "b": {"c": None}})
    assert text == '{"a":[1,2],"b":{"c":null}}'


# Spec §6 check 1: frames computed with ryuo.py on 2026-10-23.
REFERENCE = [
    (1, "brightness", {"value": 60}, 87, "b68c81480d02a72108d32ed9a47494fc5939b5f84eaf3147e37881e52dbf8355"),
    (2, "disconn", None, 71, "ebbd91e285e71fb74f59cc062e41076fd9e5b98e5cce12a36315321b6da8ede1"),
    (
        3,
        "preset",
        {
            "id": "Customization",
            "sysinfoDisplay": ["CPU Temperature", "", "", "", "", ""],
            "settings": {
                "titleColor": "#E5252B",
                "contentColor": "#FFFFFF",
                "filter": {"value": None, "opacity": 100},
                "badges": [],
            },
        },
        259,
        "3a998ec812203e785388ece02b2a2f4b770669b401643f0a55ed11db62f4f7fc",
    ),
]


@pytest.mark.parametrize(("seq", "cmd", "body", "size", "sha"), REFERENCE, ids=[r[1] for r in REFERENCE])
def test_reference_frames(seq, cmd, body, size, sha):
    frame, _ = P.message("POST", cmd, seq, body)
    assert len(frame) == size
    assert hashlib.sha256(frame).hexdigest() == sha


def test_reference_preset_matches_builders():
    built = P.preset(["CPU Temperature"], P.settings("#E5252B", "#FFFFFF"))
    assert built == REFERENCE[2][2]
    frame, _ = P.message("POST", "preset", 3, built)
    assert hashlib.sha256(frame).hexdigest() == REFERENCE[2][4]


# ---------------------------------------------------------------- parse_reply


def test_parse_reply_full():
    text = '1 200\r\nAckNumber=8\r\nContentLength=11\r\n\r\n{"ok":true}'
    assert P.parse_reply(text) == (200, 8, {"ok": True})


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1 200\r\nAckNumber=3\r\n\r\n", (200, 3, None)),
        ("1 200\r\n\r\n{}", (200, None, {})),
        ("1 500\r\nAckNumber=-1\r\n\r\n", (500, -1, None)),
        ("1 200\r\nAckNumber=x\r\n\r\n", (200, None, None)),
        ("1 200\r\nAckNumber=4\r\n\r\n[1,2]", (200, 4, None)),
        ("1 200\r\nAckNumber=4\r\n\r\n{broken", (200, 4, None)),
        ("garbage", (None, None, None)),
        ("", (None, None, None)),
    ],
)
def test_parse_reply_partial(text, expected):
    assert P.parse_reply(text) == expected


# ---------------------------------------------------------------- ReplyBuffer


def reply_frame(seq, body=None):
    text = f"1 200\r\nAckNumber={seq}\r\n\r\n" + ("" if body is None else json.dumps(body))
    return text, P.encode(text.encode())


def test_reply_buffer_single_padded_report():
    text, frame = reply_frame(2)
    assert P.ReplyBuffer().feed(frame.ljust(P.REPORT_LEN, b"\x00")) == [text]


def test_reply_buffer_reassembles_across_reports():
    text, frame = reply_frame(2, {"media": {"custom": ["x" * 40] * 40}})
    assert len(frame) > P.REPORT_LEN
    buf = P.ReplyBuffer()
    assert buf.feed(frame[: P.REPORT_LEN]) == []
    assert buf.feed(frame[P.REPORT_LEN :].ljust(P.REPORT_LEN, b"\x00")) == [text]
    assert buf.buf == bytearray()


def test_reply_buffer_reassembles_across_three_reports():
    text, frame = reply_frame(9, {"media": {"custom": ["y" * 50] * 50}})
    assert len(frame) > 2 * P.REPORT_LEN
    buf = P.ReplyBuffer()
    out = []
    for i in range(0, len(frame), P.REPORT_LEN):
        out += buf.feed(frame[i : i + P.REPORT_LEN].ljust(P.REPORT_LEN, b"\x00"))
    assert out == [text]


def test_reply_buffer_two_frames_in_one_report():
    t1, f1 = reply_frame(2)
    t2, f2 = reply_frame(3, {"status": {"fanLCD": "off"}})
    assert P.ReplyBuffer().feed((f1 + f2).ljust(P.REPORT_LEN, b"\x00")) == [t1, t2]


def test_reply_buffer_skips_junk_and_lost_half():
    # A lost first half leaves "...tail 5A"; that 5A must not swallow the next frame's opener.
    t1, f1 = reply_frame(2, {"k": "v" * 30})
    t2, f2 = reply_frame(3)
    buf = P.ReplyBuffer()
    assert buf.feed(b"junk" + f1[20:].ljust(P.REPORT_LEN, b"\x00")) == []
    assert buf.feed(f2.ljust(P.REPORT_LEN, b"\x00")) == [t2]
    assert buf.feed(f1) == [t1]


def test_reply_buffer_garbage_without_marker_is_dropped():
    buf = P.ReplyBuffer()
    assert buf.feed(b"abc") == []
    assert buf.buf == bytearray()


def test_reply_buffer_bounded():
    # An opener whose closing 0x5A never comes: the buffer is cleared past 16 reports.
    buf = P.ReplyBuffer()
    buf.feed(b"\x5a" + b"a" * (P.REPORT_LEN - 1))
    sizes = []
    for _ in range(20):
        buf.feed(b"a" * P.REPORT_LEN)
        sizes.append(len(buf.buf))
    assert max(sizes) <= 16 * P.REPORT_LEN
    assert 0 in sizes


def _frame_with_zero_crc_ending_at_report_edge():
    """A 1025-byte reply frame whose crc is 0x00, so the first report ends in that 0x00 byte."""
    for n in range(900, 1000):
        for c in range(0x20, 0x7F):
            if c in (0x5A, 0x5B, 0x22, 0x5C):
                continue
            text = "1 200\r\nAckNumber=2\r\n\r\n" + json.dumps({"x": "a" * n + chr(c)})
            frame = P.encode(text.encode())
            if len(frame) == P.REPORT_LEN + 1 and frame[-2] == 0x00:
                return text, frame
    raise AssertionError("no such frame found")


@pytest.mark.xfail(
    strict=True,
    reason="BUG: ReplyBuffer.feed (ryuo_proto.py:103) rstrips 0x00 from every report, so a frame "
    "split right after a 0x00 crc byte loses that byte and the reply is dropped",
)
def test_reply_buffer_keeps_zero_crc_at_report_boundary():
    text, frame = _frame_with_zero_crc_ending_at_report_edge()
    buf = P.ReplyBuffer()
    out = buf.feed(frame[: P.REPORT_LEN])
    out += buf.feed(frame[P.REPORT_LEN :].ljust(P.REPORT_LEN, b"\x00"))
    assert out == [text]
