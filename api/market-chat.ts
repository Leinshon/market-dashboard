import type { VercelRequest, VercelResponse } from '@vercel/node'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' })
  }

  try {
    const { question, marketContext } = req.body

    if (!question) {
      return res.status(400).json({ error: 'Question is required' })
    }

    const systemPrompt = `당신은 월가 출신 시장 전략가입니다. 제공된 시장 지표 데이터를 기반으로 투자자에게 객관적인 분석을 제공합니다.

[답변 구조]
1. 현황 진단: 현재 시장 상태를 한 문장으로 요약
2. 핵심 시그널: 가장 주목할 2-3개 지표와 의미
3. 리스크 요인: 주의해야 할 점
4. 기회 요인: 현재 환경에서의 기회

[규칙]
- 500자 이내로 답변
- 인사, 감사, 마무리 멘트 없이 바로 본론
- 숫자와 근거를 명시
- 불확실한 부분은 솔직하게 인정
- 특정 투자 방식을 강요하지 말고 객관적 사실 전달`

    const userMessage = `[현재 시장 지표 - ${marketContext.date}]
${marketContext.indicators}

[질문]
${question}`

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: `${systemPrompt}\n\n${userMessage}` }],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 600,
          },
        }),
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Gemini API error:', errorText)
      return res.status(response.status).json({ error: 'Gemini API error' })
    }

    const data = await response.json()
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || '답변을 생성할 수 없습니다.'

    return res.status(200).json({ answer })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
