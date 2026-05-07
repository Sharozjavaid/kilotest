"""CLI entry point.

Usage:
  python main.py "AI meal planner for college students with budgets under $50/week"
"""
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from src.run import generate_landing_page  # noqa: E402


def main() -> None:
    if len(sys.argv) < 2:
        print('Usage: python main.py "<your idea here>"', file=sys.stderr)
        sys.exit(2)
    idea = " ".join(sys.argv[1:]).strip()
    if not idea:
        print("Idea must be non-empty.", file=sys.stderr)
        sys.exit(2)

    url = generate_landing_page(idea=idea)
    print()
    print("=" * 60)
    print(f"DEPLOYED: {url}")
    print("=" * 60)


if __name__ == "__main__":
    main()
