import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const { instance_id, remote_instance_id } = await request.json()

    if (!instance_id) {
      return NextResponse.json(
        { error: 'instance_id is required' },
        { status: 400 }
      )
    }

    // Get stream URL directly using Scrapybara API
    const instanceId = remote_instance_id || instance_id
    const apiUrl = `https://api.scrapybara.com/v1/instance/${instanceId}/stream_url`
    
    const streamResponse = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'x-api-key': process.env.SCRAPYBARA_API_KEY || '',
      },
    })

    if (!streamResponse.ok) {
      return NextResponse.json(
        { error: 'Failed to get stream URL' },
        { status: streamResponse.status }
      )
    }

    const streamData = await streamResponse.json()
    const streamUrl = streamData.stream_url

    if (!streamUrl) {
      return NextResponse.json(
        { error: 'No stream URL available' },
        { status: 500 }
      )
    }

    console.log('Got stream URL for instance:', instance_id, streamUrl)

    return NextResponse.json({
      success: true,
      stream_url: streamUrl,
      instance_id,
      remote_instance_id
    })

  } catch (error: any) {
    console.error('Error getting stream URL:', error)
    return NextResponse.json(
      { error: 'Failed to get stream URL', details: error.message },
      { status: 500 }
    )
  }
}