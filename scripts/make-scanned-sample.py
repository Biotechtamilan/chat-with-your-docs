"""Builds the scanned-PDF sample: page images with no text layer.

Each input PNG becomes one page. The result behaves like a document that came
off a scanner, which is what the OCR path is for.

Usage: uv run --with reportlab python scripts/make-scanned-sample.py out.pdf page1.png [page2.png ...]
"""
import sys

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

out, images = sys.argv[1], sys.argv[2:]
pdf = canvas.Canvas(out, pagesize=A4)
width, height = A4
for image in images:
    pdf.drawImage(image, 0, 0, width=width, height=height)
    pdf.showPage()
pdf.save()
print("wrote", out, "pages", len(images))
