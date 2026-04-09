import { prisma } from "../src/utils/prisma";
import { normalizeUrl } from "../src/utils/sanitize";

async function cleanup() {
  console.log("Starting database cleanup...");

  const allDocs = await prisma.document.findMany({
    select: { id: true, url: true, siteKey: true },
  });

  console.log(`Checking ${allDocs.length} documents...`);

  let updatedCount = 0;

  for (const doc of allDocs) {
    const normalizedUrl = normalizeUrl(doc.url);
    const normalizedSiteKey = doc.siteKey ? normalizeUrl(doc.siteKey) : null;

    let newSiteKey = normalizedSiteKey;
    // If it's a root document (url matches siteKey), set siteKey to null
    if (normalizedSiteKey === normalizedUrl) {
      newSiteKey = null;
    }

    if (newSiteKey !== doc.siteKey || normalizedUrl !== doc.url) {
      await prisma.document.update({
        where: { id: doc.id },
        data: {
          url: normalizedUrl,
          siteKey: newSiteKey,
        },
      });
      updatedCount++;
    }
  }

  console.log(`Cleanup complete. ${updatedCount} documents updated.`);
}

cleanup()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
