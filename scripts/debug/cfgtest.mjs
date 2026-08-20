import('../../packages/config/src/index.ts').then((m) => {
  console.log(
    'BEFORE ' +
      JSON.stringify({
        eAuto: process.env.AUTO_APPROVE_ALL,
        eLlm: process.env.LLM_PROVIDER,
        eTts: process.env.VOICE_TTS_ENABLED,
      }),
  );
  const c = m.loadConfig({}, { loadDotenv: true });
  console.log(
    'AFTER ' + JSON.stringify({ auto: c.autoApproveAll, provider: c.llmProvider, tts: c.voiceTtsEnabled }),
  );
});
