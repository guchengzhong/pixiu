from pypdf import PdfReader, PdfWriter
import os

input_pdf = "uploads/atc22-li-zijun-rund.pdf"
pages_dir = "output/pages"
summaries_dir = "output/summaries"

reader = PdfReader(input_pdf)
num_pages = len(reader.pages)

print(f"Total pages: {num_pages}")

# Split into individual PDFs
for i in range(num_pages):
    writer = PdfWriter()
    writer.add_page(reader.pages[i])
    out_path = os.path.join(pages_dir, f"page_{i+1:02d}.pdf")
    with open(out_path, "wb") as f:
        writer.write(f)
    print(f"Written {out_path}")

# Extract text from each page and save
for i in range(num_pages):
    text = reader.pages[i].extract_text()
    out_path = os.path.join(summaries_dir, f"page_{i+1:02d}.txt")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text or "")
    print(f"Extracted text to {out_path}")

print("Done splitting and extracting.")
