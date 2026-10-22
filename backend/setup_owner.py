"""Initialize this installation's sole owner using a local interactive prompt."""

from getpass import GetPassWarning, getpass
import sys
import warnings

from dotenv import load_dotenv

from auth import auth_database_path
from auth_store import AuthStore, OwnerSetupError


def main() -> int:
    """Prompt locally and fail closed if hidden password entry is unavailable."""
    load_dotenv()
    if len(sys.argv) != 1 or not sys.stdin.isatty():
        print("Run setup_owner.py interactively, without arguments.")
        return 1
    store = AuthStore(auth_database_path())
    if store.has_owner():
        print("This installation already has an owner.")
        return 1
    print("The sole owner will have access to this installation's existing local data.")
    try:
        if input("Type INITIALIZE to accept and continue: ") != "INITIALIZE":
            print("Setup canceled.")
            return 1
        username = input("Owner username: ").strip()
        # Fail rather than fall back to echoing secrets in an unsupported terminal.
        with warnings.catch_warnings():
            warnings.simplefilter("error", GetPassWarning)
            password = getpass("Passphrase (15–128 characters): ")
            confirmation = getpass("Confirm passphrase: ")
        if password != confirmation:
            raise OwnerSetupError("Passphrases did not match.")
        store.create_owner(username, password)
    except (OwnerSetupError, GetPassWarning, EOFError, KeyboardInterrupt) as exc:
        print(str(exc) if isinstance(exc, OwnerSetupError) else "Setup canceled safely.")
        return 1
    print("Owner initialized. Start Clawbit and sign in.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
