"""Writes the text PDF that the scanned sample is made from.

Usage: uv run --with reportlab python scripts/make-field-report.py out.pdf
Then render its pages to PNG (scripts/render-pdf-pages.mjs) and wrap them
with scripts/make-scanned-sample.py to get a PDF with no text layer.
"""
import sys

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

styles = getSampleStyleSheet()
body = styles["BodyText"]
body.leading = 17
body.fontSize = 11
story = [Paragraph("Field service report FS-2291", styles["Title"]), Spacer(1, 14)]
for heading, text in [
    ("Visit", "Site: Harrow Lane pumping station. Date of visit: 12 February. Technician: Ines Okafor. Customer contact: Daniel Reyes, operations lead."),
    ("Reported fault", "Sensor TW-7740 was reporting error E-4012 (calibration drift) since 9 February. Readings were 3.4 percent above the reference probe."),
    ("Work carried out", "The probe membrane was worn and was replaced with part PM-118. The sensor was recalibrated with conductivity standard 1413 and passed verification at 0.3 percent deviation. Firmware was updated from 3.1 to 3.4 in two steps."),
    ("Follow-up", "Readings recorded between 9 February and 12 February remain flagged as provisional. A return visit is booked for 12 May to check the new membrane. The battery was at 61 percent and does not need replacing."),
    ("Sign-off", "Work accepted by Daniel Reyes on 12 February at 15:40. Report filed by Ines Okafor."),
]:
    story.append(Paragraph(heading, styles["Heading2"]))
    story.append(Paragraph(text, body))
    story.append(Spacer(1, 10))
SimpleDocTemplate(sys.argv[1], pagesize=A4, title="Field service report").build(story)
print("wrote", sys.argv[1])
