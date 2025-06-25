import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseClient } from '@/lib/database/supabase-server'

// Initialize Stripe server-side
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { 
      taskId, 
      campaignId, 
      amount, 
      currency = 'usd',
      productName,
      productDescription,
      productImages = [],
      siteId,
      userEmail 
    } = body

    // Validate required fields
    if (!amount || !productName || !siteId || !userEmail) {
      return NextResponse.json(
        { error: 'Missing required fields: amount, productName, siteId, userEmail' },
        { status: 400 }
      )
    }

    // Note: This endpoint is not protected by authentication to allow Stripe webhooks

    // Create the checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
              name: productName,
              description: productDescription,
              images: productImages,
              metadata: {
                type: taskId ? 'task_outsourcing' : 'campaign_outsourcing',
                task_id: taskId || '',
                campaign_id: campaignId || '',
                site_id: siteId,
              }
            },
            unit_amount: Math.round(amount * 100), // Convert to cents
            tax_behavior: 'exclusive', // Required for automatic tax calculation
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      customer_email: userEmail,
      metadata: {
        type: taskId ? 'task_outsourcing' : 'campaign_outsourcing',
        task_id: taskId || '',
        campaign_id: campaignId || '',
        site_id: siteId,
        user_email: userEmail,
      },
      success_url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/outsource/confirmation?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/outsource/checkout?${taskId ? `taskId=${taskId}` : `campaignId=${campaignId}`}&canceled=true`,
      billing_address_collection: 'required',
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'IE', 'PT', 'PL', 'CZ', 'HU', 'SK', 'SI', 'HR', 'EE', 'LV', 'LT', 'LU', 'MT', 'CY', 'GR', 'BG', 'RO', 'JP', 'SG', 'HK', 'NZ', 'KR', 'BR', 'MX', 'AR', 'CL', 'CO', 'PE', 'IN', 'IL', 'ZA', 'AE', 'SA', 'TR', 'RU', 'CN', 'TH', 'MY', 'ID', 'PH', 'VN', 'TW'],
      },
      allow_promotion_codes: true,
      automatic_tax: {
        enabled: true,
      },
    })

    return NextResponse.json({ sessionId: session.id, url: session.url })

  } catch (error) {
    console.error('Error creating checkout session:', error)
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    )
  }
} 