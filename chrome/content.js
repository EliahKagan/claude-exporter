// Prevent double-injection of content script
if (window.claudeExporterContentScriptLoaded) {
  console.log('Claude Exporter content script already loaded, skipping re-injection');
} else {
  window.claudeExporterContentScriptLoaded = true;

// Capture unhandled errors for diagnostics (sanitized, stored in chrome.storage.local)
if (typeof initErrorCapture === 'function') initErrorCapture('content');

// Note: Organization ID is now stored in extension settings
// Users need to configure it in the extension options page

// Record export timestamp for a conversation
function recordExportTimestamp(conversationId) {
  chrome.storage.local.get(['exportTimestamps'], (result) => {
    const timestamps = result.exportTimestamps || {};
    timestamps[conversationId] = new Date().toISOString();
    chrome.storage.local.set({ exportTimestamps: timestamps }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to record export timestamps:', chrome.runtime.lastError.message);
      }
    });
  });
}

// Record export timestamps for multiple conversations
// Mirrors browse.js: merge into what storage currently holds and report a
// failed write, rather than dropping it silently.
function recordExportTimestamps(conversationIds, exportedAt) {
  chrome.storage.local.get(['exportTimestamps'], (result) => {
    const timestamps = result.exportTimestamps || {};
    // See browse.js: stamped with the run's start, not its end, so a
    // conversation edited during a long run is not marked already-exported.
    const now = exportedAt || new Date().toISOString();
    for (const id of conversationIds) {
      timestamps[id] = now;
    }
    chrome.storage.local.set({ exportTimestamps: timestamps }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to record export timestamps:', chrome.runtime.lastError.message);
      }
    });
  });
}

// Snapshot each conversation's current model so it survives a model bounce
// (e.g. when a model retires and Claude silently moves old chats onto a new
// one). Only the raw API model is recorded — never an inferred guess.
function recordModelSnapshots(conversations) {
  if (!Array.isArray(conversations)) return;
  chrome.storage.local.get(['modelSnapshots'], (result) => {
    const snapshots = result.modelSnapshots || {};
    const now = new Date().toISOString();
    let changed = false;
    for (const conv of conversations) {
      const model = conv && conv.model;
      const id = conv && conv.uuid;
      if (!model || !id) continue; // skip null-model chats — don't snapshot a guess
      const existing = snapshots[id];
      if (!existing) {
        snapshots[id] = {
          firstSeen: model,
          firstSeenAt: now,
          current: model,
          currentAt: now,
          history: [{ model, at: now }]
        };
        changed = true;
      } else if (existing.current !== model) {
        existing.current = model;
        existing.currentAt = now;
        existing.history = existing.history || [];
        existing.history.push({ model, at: now });
        changed = true;
      }
    }
    if (changed) {
      chrome.storage.local.set({ modelSnapshots: snapshots });
    }
  });
}

// Helper function to format datetime in local time for filenames
function getLocalDateTimeString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

  // Fetch conversation data
  async function fetchConversation(orgId, conversationId, pacer = createPacer(0)) {
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;

    const response = await fetchWithBackoff(url, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      }
    }, pacer);

    if (!response.ok) {
      throw new Error(`Failed to fetch conversation: ${response.status}`);
    }

    return await response.json();
  }
  
  // Fetch all conversations
  async function fetchAllConversations(orgId) {
    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations`;
    
    // Through the backoff helper: a single 429 here aborts the whole export
    // before anything is written, and this is also the call the browse page
    // relays through.
    const response = await fetchWithBackoff(url, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
      }
    }, createPacer(0));
    
    if (!response.ok) {
      throw new Error(`Failed to fetch conversations: ${response.status}`);
    }

    const conversations = await response.json();
    recordModelSnapshots(conversations); // capture current models before any bounce
    return conversations;
  }
  // Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Liveness probe from the browse page, answered before anything else and
  // synchronously: it reports only whether this content script can still reply.
  if (request.action === 'ping') {
    sendResponse({ success: true });
    return false;
  }

  // Auto-detect organization ID from Claude.ai API
  if (request.action === 'detectOrgId') {
    console.log('Auto-detecting organization ID...');

    fetch('https://claude.ai/api/organizations', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    })
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to fetch organizations: ${response.status}`);
        }
        return response.json();
      })
      .then(orgs => {
        if (Array.isArray(orgs) && orgs.length > 0) {
          // Find the org with "chat" capability (the Claude.ai org, not the API org)
          const chatOrg = orgs.find(org =>
            org.capabilities && org.capabilities.includes('chat')
          );
          const orgId = chatOrg ? chatOrg.uuid : orgs[0].uuid;
          console.log('Auto-detected organization ID:', orgId, chatOrg ? '(chat org)' : '(fallback to first)');
          sendResponse({ success: true, orgId });
        } else {
          throw new Error('No organizations found');
        }
      })
      .catch(error => {
        console.error('Auto-detect org ID failed:', error);
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }

  if (request.action === 'exportConversation') {
    console.log('Export conversation request received:', request);

    fetchConversation(request.orgId, request.conversationId)
      .then(async data => {
        console.log('Conversation data fetched successfully:', data);

        // Validate conversation data structure
        if (!data || !data.chat_messages || !Array.isArray(data.chat_messages)) {
          throw new Error('Invalid conversation data structure. Please refresh the page and try again.');
        }

        // Same sanitizing the bulk path applies; this export builds its own ZIP.
        const safeName = safeConversationName(data.name, request.conversationId);

        // Infer model if null
        data.model = inferModel(data);
        
        // Check if we need to extract artifacts to separate files
        if (request.extractArtifacts || request.flattenArtifacts) {
          // Extract artifacts
          const artifactFiles = extractArtifactFiles(data, request.artifactFormat || 'original');

          if (artifactFiles.length > 0) {
            // Create a ZIP with artifacts (and optionally conversation)
            const zip = new JSZip();

            // Add conversation file only if includeChats is true
            if (request.includeChats !== false) {
              let conversationContent, conversationFilename;
              switch (request.format) {
                case 'markdown':
                  conversationContent = convertToMarkdown(data, request.includeMetadata, request.conversationId, request.includeArtifacts, request.includeThinking);
                  conversationFilename = `${safeName}.md`;
                  break;
                case 'text':
                  conversationContent = convertToText(data, request.includeMetadata, request.includeArtifacts, request.includeThinking);
                  conversationFilename = `${safeName}.txt`;
                  break;
                default:
                  conversationContent = JSON.stringify(data, null, 2);
                  conversationFilename = `${safeName}.json`;
              }

              // Flat export: add to Chats folder
              if (request.flattenArtifacts && !request.extractArtifacts) {
                const chatsFolder = zip.folder('Chats');
                chatsFolder.file(conversationFilename, toZipBytes(conversationContent));
              } else {
                // Nested or no artifact extraction: add to root
                zip.file(conversationFilename, toZipBytes(conversationContent));
              }
            }

            // Add artifact files
            // Nested: create artifacts subfolder
            if (request.extractArtifacts) {
              const artifactsFolder = request.includeChats !== false ? zip.folder('artifacts') : zip;
              for (const artifact of artifactFiles) {
                artifactsFolder.file(artifact.filename, toZipBytes(artifact.content));
              }
            }

            // Flat: add artifacts with conversation name prefix to Artifacts folder
            if (request.flattenArtifacts && !request.extractArtifacts) {
              const artifactsFolder = zip.folder('Artifacts');
              for (const artifact of artifactFiles) {
                const filename = `${safeName}_${artifact.filename}`;
                artifactsFolder.file(filename, toZipBytes(artifact.content));
              }
            }

            // Awaited before the timestamp is recorded, for the same reason as
            // the bulk paths: a rejected generateAsync would otherwise leave the
            // conversation marked exported with nothing downloaded.
            const blob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${safeName}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            console.log(`Downloading ZIP with conversation and ${artifactFiles.length} artifact(s)`);
            recordExportTimestamp(request.conversationId);
            sendResponse({ success: true });
          } else {
            // No artifacts found, just export conversation normally
            let content, filename, type;
            switch (request.format) {
              case 'markdown':
                content = convertToMarkdown(data, request.includeMetadata, request.conversationId, request.includeArtifacts, request.includeThinking);
                filename = `${safeName}.md`;
                type = 'text/markdown';
                break;
              case 'text':
                content = convertToText(data, request.includeMetadata, request.includeArtifacts, request.includeThinking);
                filename = `${safeName}.txt`;
                type = 'text/plain';
                break;
              default:
                content = JSON.stringify(data, null, 2);
                filename = `${safeName}.json`;
                type = 'application/json';
            }
            console.log('No artifacts found. Downloading file:', filename);
            downloadFile(content, filename, type);
            recordExportTimestamp(request.conversationId);
            sendResponse({ success: true });
          }
        } else {
          // Normal export without artifact extraction
          if (request.includeChats === false) {
            // If chats are disabled and we're not extracting artifacts, there's nothing to export
            console.log('No content to export (chats disabled, artifacts not extracted)');
            sendResponse({
              success: false,
              error: 'Nothing to export. Enable "Include conversation text" or "Artifacts nested".'
            });
          } else {
            let content, filename, type;
            switch (request.format) {
              case 'markdown':
                content = convertToMarkdown(data, request.includeMetadata, request.conversationId, request.includeArtifacts, request.includeThinking);
                filename = `${safeName}.md`;
                type = 'text/markdown';
                break;
              case 'text':
                content = convertToText(data, request.includeMetadata, request.includeArtifacts, request.includeThinking);
                filename = `${safeName}.txt`;
                type = 'text/plain';
                break;
              default:
                content = JSON.stringify(data, null, 2);
                filename = `${safeName}.json`;
                type = 'application/json';
            }

            console.log('Downloading file:', filename);
            downloadFile(content, filename, type);
            recordExportTimestamp(request.conversationId);
            sendResponse({ success: true });
          }
        }
      })
      .catch(error => {
        console.error('Export conversation error:', error);
        sendResponse({ 
          success: false, 
          error: error.message,
          details: error.stack 
        });
      });
    
    return true;
  }
    
      if (request.action === 'exportAllConversations') {
    console.log('Export all conversations request received:', request);
    
    fetchAllConversations(request.orgId)
      .then(async conversations => {
        console.log(`Fetched ${conversations.length} conversations`);
        
        // One manifest entry per conversation, created up front so every
        // conversation appears exactly once. Keyed by UUID: the old code keyed
        // failures by name and then tested those strings for the UUID, so any
        // named conversation that failed was recorded as successfully exported.
        const manifestEntries = conversations.map(conv => ({
          uuid: conv.uuid,
          title: conv.name || null,
          status: 'pending',
          files: []
        }));
        const manifestByUuid = new Map(manifestEntries.map(entry => [entry.uuid, entry]));

        // Collision-free names decided before the loop, so numbering does not
        // depend on completion order.
        const safeNames = dedupeConversationNames(conversations, [
          EXPORT_MANIFEST_BASENAME, EXPORT_MANIFEST_FILENAME
        ]);

        const pacer = createPacer(500);
        const runStartedAt = new Date().toISOString();

        // Shared tail for both export shapes.
        const finishExport = async (zip, prefix) => {
          const reconciliation = reconcileManifest(manifestEntries, zip);
          const reconciledIds = exportedUuids(manifestEntries, reconciliation);

          // Plain zip.file: the name is reserved in the dedup set above, so it
          // cannot collide, and throwing here would destroy the whole archive
          // at the last step.
          zip.file(EXPORT_MANIFEST_FILENAME, toZipBytes(JSON.stringify({
            generatedAt: new Date().toISOString(),
            cancelled: false,   // no cancel button on this path; kept so the schema matches
            total: manifestEntries.length,
            // Same buckets the browse page writes, so a consumer gets one
            // contract whichever button produced the archive. Every
            // conversation lands in exactly one, so these sum to total.
            counts: {
              exported: reconciledIds.length,
              unreconciled: reconciliation.missing.length,
              skipped: manifestEntries.filter(entry => entry.status === 'skipped').length,
              failed: manifestEntries.filter(entry => entry.status === 'failed').length,
              cancelled: 0,
              pending: manifestEntries.filter(entry => entry.status === 'pending').length
            },
            reconciliation,
            conversations: manifestEntries
          }, null, 2)));

          // Awaited: the old code started generateAsync and recorded export
          // timestamps without waiting for it, so a generation failure still
          // left every conversation marked as exported.
          const blob = await zip.generateAsync({ type: 'blob' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${prefix}-${getLocalDateTimeString()}.zip`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          // Only conversations whose files are provably in the archive get a
          // timestamp; anything else stays flagged as new on the next run.
          recordExportTimestamps(reconciledIds, runStartedAt);

          // Reported through the popup's existing warnings channel rather than
          // alert(): a content script's alert is tab-modal, is deferred while
          // the tab is in the background, and would block sendResponse until
          // someone dismissed a dialog they cannot see. Kept separate from the
          // per-conversation failure list so an integrity problem does not read
          // as one more ordinary failure.
          const problems = [];
          if (!reconciliation.ok) {
            problems.push(`INTEGRITY: ${reconciliation.missing.length} conversation(s) are missing files from the ZIP`);
          }
          const duplicates = manifestEntries.filter(entry => entry.duplicateZipEntry);
          if (duplicates.length > 0) {
            problems.push(`INTEGRITY: ${duplicates.length} conversation(s) hit a duplicate ZIP path`);
          }

          return { count: reconciledIds.length, problems };
        };

        const describeFailures = () => manifestEntries
          .filter(entry => entry.status === 'failed')
          .map(entry => `${entry.title || entry.uuid}: ${entry.reason}`);

        if (request.extractArtifacts || request.flattenArtifacts) {
          // When extracting artifacts (nested or flat), always create a ZIP
          const zip = new JSZip();
          let processed = 0;
          let included = 0;

          for (const conv of conversations) {
            const entry = manifestByUuid.get(conv.uuid);
            try {
              processed++;
              console.log(`Scanning conversation ${processed}/${conversations.length}: ${conv.name || conv.uuid}`);
              const fullConv = await fetchConversation(request.orgId, conv.uuid, pacer);
              assertConversationShape(fullConv);

              // Infer model if null
              fullConv.model = inferModel(fullConv);

              // Extract artifacts first to check if this conversation should be included
              const artifactFiles = extractArtifactFiles(fullConv, request.artifactFormat || 'original');

              // If chats are disabled and no artifacts, skip this conversation
              if (request.includeChats === false && artifactFiles.length === 0) {
                console.log(`  Skipping - no artifacts found (${processed}/${conversations.length} scanned, ${included} included)`);
                entry.status = 'skipped';
                entry.reason = 'no artifacts found (chats disabled)';
                continue;
              }

              const folderName = safeNames.get(conv.uuid);

              // Generate conversation content
              let conversationContent, conversationFilename;
              if (request.format === 'markdown') {
                conversationContent = convertToMarkdown(fullConv, request.includeMetadata, conv.uuid, request.includeArtifacts, request.includeThinking);
                conversationFilename = `${folderName}.md`;
              } else if (request.format === 'text') {
                conversationContent = convertToText(fullConv, request.includeMetadata, request.includeArtifacts, request.includeThinking);
                conversationFilename = `${folderName}.txt`;
              } else {
                conversationContent = JSON.stringify(fullConv, null, 2);
                conversationFilename = `${folderName}.json`;
              }

              // Every write goes through addZipFile with a full root-relative
              // path, so the manifest records exactly what was written.
              const writeFile = (path, body) => {
                addZipFile(zip, path, body);
                entry.files.push(path);
              };

              // Flat export: use Chats and Artifacts top-level folders
              if (request.flattenArtifacts && !request.extractArtifacts) {
                // Add chat file to Chats folder if chats are enabled
                if (request.includeChats !== false) {
                  writeFile(`Chats/${conversationFilename}`, conversationContent);
                }

                // Add artifacts to Artifacts folder with conversation name prefix.
                // Through uniqueZipPath: the "_" join is also the dedup suffix
                // character, so two conversations with collision-free names can
                // still compose the same path.
                for (const artifact of artifactFiles) {
                  writeFile(uniqueZipPath(zip, `Artifacts/${folderName}_${artifact.filename}`), artifact.content);
                }
              }
              // Nested export: create per-conversation folders with artifacts subfolder
              else if (request.extractArtifacts) {
                // Add conversation file only if includeChats is true
                if (request.includeChats !== false) {
                  writeFile(`${folderName}/${conversationFilename}`, conversationContent);
                }

                // Add artifact files in nested artifacts subfolder
                const artifactPrefix = request.includeChats !== false ? `${folderName}/artifacts/` : `${folderName}/`;
                for (const artifact of artifactFiles) {
                  writeFile(`${artifactPrefix}${artifact.filename}`, artifact.content);
                }
              }

              entry.status = entry.files.length > 0 ? 'exported' : 'skipped';
              if (entry.status === 'skipped') {
                entry.reason = 'nothing to write for the selected options';
              }
              if (entry.status === 'exported') {
                included++;
                console.log(`  Added to export (${processed}/${conversations.length} scanned, ${included} included)`);
              }
            } catch (error) {
              console.error(`Failed to export conversation ${conv.uuid}:`, error);
              entry.status = 'failed';
              entry.reason = error.message;
              if (error.duplicateZipEntry) {
                entry.duplicateZipEntry = true;
              }
            }
          }

          // Use 'claude-artifacts' when ONLY flat artifacts are exported
          const prefix = (request.flattenArtifacts && !request.extractArtifacts && request.includeChats === false) ? 'claude-artifacts' : 'claude-exports';
          const { count: exportedCount, problems } = await finishExport(zip, prefix);

          const failures = describeFailures();
          if (exportedCount === 0 && failures.length === 0 && problems.length === 0) {
            // Nothing matched the selected options — chats disabled with no
            // artifact extraction, say. Reporting plain success here would
            // present an archive holding only a manifest as a completed export.
            sendResponse({
              success: true,
              count: 0,
              warnings: `Nothing was exported: none of the ${conversations.length} conversations produced a file with the options selected.`
            });
          } else if (problems.length > 0 || failures.length > 0) {
            console.warn('Export completed with problems:', { problems, failures });
            const detail = [];
            if (problems.length > 0) detail.push(problems.join('; '));
            if (failures.length > 0) detail.push(`Failed: ${failures.join('; ')}`);
            sendResponse({
              success: true,
              count: exportedCount,
              warnings: `Exported ${exportedCount}/${conversations.length} conversations. ${detail.join(' | ')}`
            });
          } else {
            sendResponse({ success: true, count: exportedCount });
          }
        } else {
          // For other formats without artifact extraction, create a ZIP
          const zip = new JSZip();
          let processed = 0;

          for (const conv of conversations) {
            const entry = manifestByUuid.get(conv.uuid);
            try {
              processed++;
              console.log(`Fetching full conversation ${processed}/${conversations.length}: ${conv.uuid}`);
              const fullConv = await fetchConversation(request.orgId, conv.uuid, pacer);
              assertConversationShape(fullConv);

              // Infer model if null
              fullConv.model = inferModel(fullConv);

              let content, filename;
              const safeName = safeNames.get(conv.uuid);

              if (request.format === 'markdown') {
                content = convertToMarkdown(fullConv, request.includeMetadata, conv.uuid, request.includeArtifacts, request.includeThinking);
                filename = `${safeName}.md`;
              } else if (request.format === 'text') {
                content = convertToText(fullConv, request.includeMetadata, request.includeArtifacts, request.includeThinking);
                filename = `${safeName}.txt`;
              } else {
                content = JSON.stringify(fullConv, null, 2);
                filename = `${safeName}.json`;
              }

              if (request.includeChats !== false) {
                addZipFile(zip, filename, content);
                entry.files.push(filename);
              }
              entry.status = entry.files.length > 0 ? 'exported' : 'skipped';
              if (entry.status === 'skipped') {
                entry.reason = 'nothing to write for the selected options';
              }
            } catch (error) {
              console.error(`Failed to export conversation ${conv.uuid}:`, error);
              entry.status = 'failed';
              entry.reason = error.message;
              if (error.duplicateZipEntry) {
                entry.duplicateZipEntry = true;
              }
            }
          }

          const { count: exportedCount, problems } = await finishExport(zip, 'claude-exports');

          const failures = describeFailures();
          if (exportedCount === 0 && failures.length === 0 && problems.length === 0) {
            // Nothing matched the selected options — chats disabled with no
            // artifact extraction, say. Reporting plain success here would
            // present an archive holding only a manifest as a completed export.
            sendResponse({
              success: true,
              count: 0,
              warnings: `Nothing was exported: none of the ${conversations.length} conversations produced a file with the options selected.`
            });
          } else if (problems.length > 0 || failures.length > 0) {
            console.warn('Export completed with problems:', { problems, failures });
            const detail = [];
            if (problems.length > 0) detail.push(problems.join('; '));
            if (failures.length > 0) detail.push(`Failed: ${failures.join('; ')}`);
            sendResponse({
              success: true,
              count: exportedCount,
              warnings: `Exported ${exportedCount}/${conversations.length} conversations. ${detail.join(' | ')}`
            });
          } else {
            sendResponse({ success: true, count: exportedCount });
          }
        }
      })
      .catch(error => {
        console.error('Export all conversations error:', error);
        sendResponse({
          success: false,
          error: error.message,
          details: error.stack
        });
      });

    return true;
  }

  // Handle loadConversations request from browse page
  if (request.action === 'loadConversations') {
    console.log('Load conversations request received from browse page');

    fetchAllConversations(request.orgId)
      .then(conversations => {
        sendResponse({ success: true, conversations: conversations });
      })
      .catch(error => {
        console.error('Load conversations error:', error);
        sendResponse({
          success: false,
          error: error.message
        });
      });

    return true;
  }

  // Handle loadProjects request from browse page
  if (request.action === 'loadProjects') {
    console.log('Load projects request received from browse page');

    fetch(`https://claude.ai/api/organizations/${request.orgId}/projects`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    })
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then(projects => {
        sendResponse({ success: true, projects: projects });
      })
      .catch(error => {
        console.error('Load projects error:', error);
        sendResponse({
          success: false,
          error: error.message
        });
      });

    return true;
  }
  });

} // End of double-injection guard