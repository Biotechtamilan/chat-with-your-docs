"""Builds the PDF fixtures the unit tests read from src/lib/ingest/__fixtures__.

protected.pdf   one page of text, encrypted. The password is the one written
                below; it is a test value and protects nothing.
mixed-scan.pdf  page 1 has a text layer, page 2 is a drawing with no text,
                which is what a scanned page looks like to the parser.

Usage: uv run --with reportlab python scripts/make-test-fixtures.py
"""
from pathlib import Path

from reportlab.lib.pagesizes import A5
from reportlab.pdfgen import canvas

out = Path(__file__).resolve().parent.parent / "src" / "lib" / "ingest" / "__fixtures__"
out.mkdir(parents=True, exist_ok=True)

PASSWORD = "open-sesame-42"

# invariant=1 leaves out the creation date and random id, so a rebuild gives the same bytes.
protected = canvas.Canvas(str(out / "protected.pdf"), pagesize=A5, encrypt=PASSWORD, invariant=1)
protected.setFont("Helvetica", 12)
protected.drawString(40, 520, "Confidential pricing memo.")
protected.drawString(40, 500, "The partner discount for the Atlas plan is 18 percent until 30 June.")
protected.showPage()
protected.save()

mixed = canvas.Canvas(str(out / "mixed-scan.pdf"), pagesize=A5, invariant=1)
mixed.setFont("Helvetica", 12)
mixed.drawString(40, 520, "Site visit summary.")
mixed.drawString(40, 500, "The inspection of the Harbour Road depot took place on 4 March.")
mixed.showPage()
mixed.rect(40, 300, 200, 120, fill=1)
mixed.showPage()
mixed.save()

print("wrote", out / "protected.pdf", "and", out / "mixed-scan.pdf")
