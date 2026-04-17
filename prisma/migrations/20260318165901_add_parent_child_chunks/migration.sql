-- AlterTable
ALTER TABLE "chunks" ADD COLUMN     "parent_id" TEXT,
ADD COLUMN     "parent_text" TEXT;

-- CreateIndex
CREATE INDEX "chunks_parent_id_idx" ON "chunks"("parent_id");
