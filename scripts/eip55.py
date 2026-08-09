#!/usr/bin/env python3
"""EIP-55 checksum validation for wallet addresses — run before adding anyone
to TRADERS in app.js. A mixed-case address carries its own checksum; if it
doesn't validate, the address was mistyped and will silently track nothing.

Usage:  python3 scripts/eip55.py 0xAddress [0xAddress ...]

Pure python (no deps): hashlib's sha3_256 is NIST SHA-3, NOT the Keccak-256
Ethereum uses, so Keccak is implemented here and self-tested on import.
"""

RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]
M = (1 << 64) - 1


def _rotl(x, n):
    n %= 64
    return ((x << n) | (x >> (64 - n))) & M


def _keccak_f(A):
    for rnd in range(24):
        C = [A[x][0] ^ A[x][1] ^ A[x][2] ^ A[x][3] ^ A[x][4] for x in range(5)]
        D = [C[(x - 1) % 5] ^ _rotl(C[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                A[x][y] ^= D[x]
        B = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                B[y][(2 * x + 3 * y) % 5] = _rotl(A[x][y], ROT[x][y])
        for x in range(5):
            for y in range(5):
                A[x][y] = B[x][y] ^ ((~B[(x + 1) % 5][y]) & B[(x + 2) % 5][y] & M)
        A[0][0] ^= RC[rnd]
    return A


def keccak256(data: bytes) -> bytes:
    rate = 136
    padded = bytearray(data) + bytearray(rate - (len(data) % rate))
    padded[len(data)] |= 0x01
    padded[-1] |= 0x80
    A = [[0] * 5 for _ in range(5)]
    for off in range(0, len(padded), rate):
        block = padded[off:off + rate]
        for i in range(rate // 8):
            A[i % 5][i // 5] ^= int.from_bytes(block[i * 8:(i + 1) * 8], "little")
        A = _keccak_f(A)
    out = bytearray()
    while len(out) < 32:
        for i in range(rate // 8):
            if len(out) >= 32:
                break
            out += A[i % 5][i // 5].to_bytes(8, "little")
    return bytes(out[:32])


def eip55(addr: str) -> str:
    a = addr.lower().replace("0x", "")
    h = keccak256(a.encode("ascii")).hex()
    return "0x" + "".join(c.upper() if int(h[i], 16) >= 8 else c for i, c in enumerate(a))


# self-test on import: published vectors
assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
assert eip55("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed") == "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    bad = 0
    for a in sys.argv[1:]:
        body = a[2:] if a.startswith("0x") else a
        if len(body) != 40:
            print(f"{a}  BAD LENGTH ({len(body)} hex chars, need 40)")
            bad += 1
            continue
        canon = eip55(a)
        mixed = body != body.lower() and body != body.upper()
        if not mixed:
            verdict = "n/a (single-case, no checksum info)"
        elif canon == a:
            verdict = "VALID"
        else:
            verdict = "*** INVALID — mistyped ***"
            bad += 1
        print(f"{a}  {verdict}")
        if mixed and canon != a:
            print(f"  canonical: {canon}")
    raise SystemExit(1 if bad else 0)
