import { kv } from '@vercel/kv'
import { OpenAIStream, StreamingTextResponse } from 'ai'
import { Configuration, OpenAIApi } from 'openai-edge'

import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'
import { Client } from 'llm-feedback-client'

export const runtime = 'edge'

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
})

const openai = new OpenAIApi(configuration)

const feedebackClient = new Client({
  projectId: process.env.NEXT_PUBLIC_LLM_PROJECT || "",
  apiKey: 'YOUR_API_KEY'
});

export async function POST(req: Request) {
  const json = await req.json()
  const { messages, previewToken, id} = json
  const userId = (await auth())?.user.id

  if (!userId) {
    return new Response('Unauthorized', {
      status: 401
    })
  }

  if (previewToken) {
    configuration.apiKey = previewToken
  }

  const llmConfig = {
    // put anything related your model setting here
    model: 'gpt-3.5-turbo',
    temperature: 0.7,
    stream: true
  }

  const configName = "VERCEL_AI_2023-08-25"

  // register LLM config
  await feedebackClient.registerConfig({
    configName, 
    config: llmConfig
  })

  // store user input
  await feedebackClient.storeContent({
    content: messages[messages.length - 1].content,
    configName: "VERCEL_AI_2023-08-25",
    groupId: id,
    createdBy: userId
  })

  const res = await openai.createChatCompletion({
    ...llmConfig,
    messages
  })

  const stream = OpenAIStream(res, {
    async onCompletion(completion) {
      const title = json.messages[0].content.substring(0, 100)
      const id = json.id ?? nanoid()
      const createdAt = Date.now()
      const path = `/chat/${id}`
      // AI content id is a hash from content, project_id and time
      const aiContentId = feedebackClient.contentUUID(completion, new Date(createdAt))

      const payload = {
        id,
        title,
        userId,
        createdAt,
        path,
        messages: [
          ...messages,
          {
            content: completion,
            role: 'assistant',
            // createdAt field here will help fetch content ID in frontend
            createdAt: new Date(createdAt)
          }
        ]
      }
      await kv.hmset(`chat:${id}`, payload)
      await kv.zadd(`user:chat:${userId}`, {
        score: createdAt,
        member: `chat:${id}`
      })
      await feedebackClient.storeContent({
        content: completion,
        id: aiContentId,
        configName,
        groupId: id,
        createdBy: 'assistant'
      })
    }
  })

  return new StreamingTextResponse(stream)
}
