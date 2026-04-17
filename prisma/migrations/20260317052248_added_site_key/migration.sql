-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "site_key" TEXT;

-- CreateIndex
CREATE INDEX "documents_site_key_idx" ON "documents"("site_key");
