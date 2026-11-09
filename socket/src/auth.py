from dataclasses import dataclass

import jwt

from .config import Config


class AuthError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass
class Identity:
    user_id: int
    username: str
    session_id: str
    expires_at: float


def authenticate(db, token: str) -> Identity:
    try:
        claims = jwt.decode(
            token,
            Config.jwt_secret,
            algorithms=["HS256"],
            audience="access",
            issuer=Config.jwt_issuer,
            options={"require": ["exp", "sub", "sid"]},
        )
    except jwt.ExpiredSignatureError:
        raise AuthError("token_expired")
    except jwt.InvalidTokenError:
        raise AuthError("invalid_token")

    row = db.fetch_one(
        """SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.id = %s::uuid AND s.revoked_at IS NULL AND s.expires_at > now()""",
        (claims["sid"],),
    )
    if not row or str(row[0]) != str(claims["sub"]):
        raise AuthError("session_revoked")
    return Identity(user_id=row[0], username=row[1], session_id=claims["sid"], expires_at=float(claims["exp"]))
