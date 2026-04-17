-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('WEBSITE', 'FILE', 'GITHUB');

-- CreateEnum
CREATE TYPE "FileType" AS ENUM ('PDF', 'DOCX', 'PPTX', 'XLSX', 'CSV', 'MD', 'TXT', 'HTML', 'CODE', 'OTHER');

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "file_name" TEXT,
ADD COLUMN     "file_size" INTEGER,
ADD COLUMN     "file_type" "FileType",
ADD COLUMN     "github_branch" TEXT,
ADD COLUMN     "github_commit_sha" TEXT,
ADD COLUMN     "github_file_path" TEXT,
ADD COLUMN     "github_install_id" INTEGER,
ADD COLUMN     "github_repo" TEXT,
ADD COLUMN     "mime_type" TEXT,
ADD COLUMN     "source_type" "SourceType" NOT NULL DEFAULT 'WEBSITE',
ADD COLUMN     "storage_path" TEXT,
ADD COLUMN     "uploaded_by" TEXT;

-- CreateIndex
CREATE INDEX "documents_source_type_idx" ON "documents"("source_type");

-- CreateIndex
CREATE INDEX "documents_uploaded_by_idx" ON "documents"("uploaded_by");

-- CreateIndex
CREATE INDEX "documents_github_repo_github_branch_idx" ON "documents"("github_repo", "github_branch");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
