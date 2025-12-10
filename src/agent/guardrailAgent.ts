import {
    Agent,
    run,
    InputGuardrailTripwireTriggered,
    InputGuardrail,
  } from '@openai/agents';
  import { z } from 'zod';
  
  const guardrailAgent = new Agent({
    name: 'Guardrail check',
    instructions: 'Check if the user is asking questions related to the field service industries like HVAC, plumbing, electrical, fire protection, and more.',
    outputType: z.object({
      isFieldServiceQuestion: z.boolean(),
      reasoning: z.string(),
    }),
  });
  
  export const fieldServiceQuestionGuardrail: InputGuardrail = {
    name: 'Field Service Question Guardrail',
    // Set runInParallel to false to block the model until the guardrail completes.
    runInParallel: false,
    execute: async ({ input, context }) => {
      const result = await run(guardrailAgent, input, { context });
      return {
        outputInfo: result.finalOutput,
        tripwireTriggered: result.finalOutput?.isFieldServiceQuestion ?? false,
      };
    },
  };