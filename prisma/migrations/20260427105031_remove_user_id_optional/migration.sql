/*
  Warnings:

  - Made the column `user_id` on table `chat_sessions` required. This step will fail if there are existing NULL values in that column.
  - Made the column `uploaded_by` on table `documents` required. This step will fail if there are existing NULL values in that column.
  - Made the column `user_id` on table `query_logs` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "chat_sessions" ALTER COLUMN "user_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "documents" ALTER COLUMN "uploaded_by" SET NOT NULL;

-- AlterTable
ALTER TABLE "query_logs" ALTER COLUMN "user_id" SET NOT NULL;
