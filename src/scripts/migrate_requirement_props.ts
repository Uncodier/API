import { supabaseAdmin } from '../lib/database/supabase-client';

async function migrateRequirementProps() {
  console.log('Starting migration of requirement properties...');

  // 1. Fetch all requirements that have backlog or progress_log in metadata
  const { data: requirements, error: fetchError } = await supabaseAdmin
    .from('requirements')
    .select('id, metadata')
    .or('metadata->backlog.not.is.null,metadata->progress_log.not.is.null');

  if (fetchError) {
    console.error('Error fetching requirements:', fetchError);
    process.exit(1);
  }

  console.log(`Found ${requirements?.length || 0} requirements to migrate.`);

  if (!requirements || requirements.length === 0) {
    console.log('No requirements to migrate. Exiting.');
    process.exit(0);
  }

  // 2. Migrate each requirement
  let successCount = 0;
  let errorCount = 0;

  for (const req of requirements) {
    try {
      const metadata = req.metadata as Record<string, any>;
      const backlog = metadata?.backlog || {};
      const progress = metadata?.progress_log || [];

      // Create new metadata object without backlog and progress_log
      const newMetadata = { ...metadata };
      delete newMetadata.backlog;
      delete newMetadata.progress_log;

      // Update the requirement with the new columns and cleaned metadata
      const { error: updateError } = await supabaseAdmin
        .from('requirements')
        .update({
          backlog,
          progress,
          metadata: newMetadata,
        })
        .eq('id', req.id);

      if (updateError) {
        console.error(`Error updating requirement ${req.id}:`, updateError);
        errorCount++;
      } else {
        successCount++;
        if (successCount % 10 === 0) {
          console.log(`Migrated ${successCount} requirements...`);
        }
      }
    } catch (e) {
      console.error(`Unexpected error processing requirement ${req.id}:`, e);
      errorCount++;
    }
  }

  console.log(`Migration complete. Success: ${successCount}, Errors: ${errorCount}`);
  
  if (errorCount > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

migrateRequirementProps();