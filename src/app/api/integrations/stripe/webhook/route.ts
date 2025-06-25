import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/database/supabase-server'
import { headers } from 'next/headers'

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

export async function POST(request: NextRequest) {
  console.log('🔍 Stripe webhook received - starting verification')
  
  // Verify webhook secret is configured
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('❌ STRIPE_WEBHOOK_SECRET not configured')
    return NextResponse.json(
      { error: 'Webhook configuration error' },
      { status: 500 }
    )
  }

  const body = await request.text()
  const headersList = await headers()
  const stripeSignature = headersList.get('stripe-signature')

  console.log('🔐 Stripe webhook signature check:', {
    hasSignature: !!stripeSignature,
    hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
    bodyLength: body.length
  })

  if (!stripeSignature) {
    console.error('❌ Missing Stripe signature header')
    return NextResponse.json(
      { error: 'Missing Stripe signature' },
      { status: 400 }
    )
  }

  let event

  try {
    // Verify the webhook signature (STRIPE_HANDSHAKE)
    event = stripe.webhooks.constructEvent(
      body,
      stripeSignature,
      process.env.STRIPE_WEBHOOK_SECRET
    )
    console.log('✅ Stripe webhook signature verified successfully')
  } catch (err: any) {
    console.error('❌ Webhook signature verification failed:', {
      message: err.message,
      signaturePresent: !!stripeSignature,
      webhookSecretConfigured: !!process.env.STRIPE_WEBHOOK_SECRET
    })
    return NextResponse.json(
      { error: 'Webhook signature verification failed.' },
      { status: 400 }
    )
  }

  console.log('✅ Stripe webhook event received:', event.type)

  try {
    // Handle different event types
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object, request)
        break
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object, request)
        break
      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('❌ Error processing webhook:', error)
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    )
  }
}

async function handleCheckoutSessionCompleted(session: any, request: NextRequest) {
  console.log('💰 Processing checkout.session.completed:', session.id)

  const supabase = supabaseAdmin
  
  // Extract metadata from session
  const {
    type,
    task_id,
    campaign_id,
    site_id,
    user_email
  } = session.metadata

  if (!site_id) {
    console.error('❌ Missing site_id in session metadata')
    return
  }

  // Create payment record
  const paymentData = {
    site_id,
    transaction_id: session.id,
    transaction_type: type || 'outsourcing',
    amount: session.amount_total / 100, // Convert from cents
    currency: session.currency.toUpperCase(),
    status: 'completed',
    payment_method: 'stripe_checkout',
    details: {
      stripe_session_id: session.id,
      customer_email: session.customer_email || user_email,
      payment_status: session.payment_status,
      session_metadata: session.metadata,
      billing_address: session.customer_details?.address,
      shipping_address: session.shipping_details?.address,
      created_at: new Date(session.created * 1000).toISOString()
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }

  // Insert payment record
  const { error: paymentError } = await supabase
    .from('payments')
    .insert(paymentData)

  if (paymentError) {
    console.error('❌ Error inserting payment record:', paymentError)
    throw paymentError
  }

  console.log('✅ Payment record created successfully')

  // Update campaign or requirement metadata based on type
  if (campaign_id && type === 'campaign_outsourcing') {
    await updateCampaignPaymentMetadata(supabase, campaign_id, session)
  }

  if (task_id && type === 'task_outsourcing') {
    await updateRequirementPaymentMetadata(supabase, task_id, session)
  }
}

async function handlePaymentIntentSucceeded(paymentIntent: any, request: NextRequest) {
  console.log('💰 Processing payment_intent.succeeded:', paymentIntent.id)

  const supabase = supabaseAdmin
  
  // Extract metadata from payment intent
  const {
    site_id,
    task_id,
    campaign_id,
    created_from
  } = paymentIntent.metadata

  if (!site_id) {
    console.error('❌ Missing site_id in payment intent metadata')
    return
  }

  // Only process if it's from outsource checkout
  if (created_from !== 'outsource_checkout') {
    console.log('ℹ️ Payment intent not from outsource checkout, skipping')
    return
  }

  // Create payment record if not already exists
  const { data: existingPayment } = await supabase
    .from('payments')
    .select('id')
    .eq('transaction_id', paymentIntent.id)
    .single()

  if (!existingPayment) {
    const paymentData = {
      site_id,
      transaction_id: paymentIntent.id,
      transaction_type: task_id ? 'task_outsourcing' : 'campaign_outsourcing',
      amount: paymentIntent.amount / 100, // Convert from cents
      currency: paymentIntent.currency.toUpperCase(),
      status: 'completed',
      payment_method: 'stripe_payment_intent',
      details: {
        stripe_payment_intent_id: paymentIntent.id,
        payment_method_id: paymentIntent.payment_method,
        customer_id: paymentIntent.customer,
        charges: paymentIntent.charges,
        metadata: paymentIntent.metadata,
        created_at: new Date(paymentIntent.created * 1000).toISOString()
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { error: paymentError } = await supabase
      .from('payments')
      .insert(paymentData)

    if (paymentError) {
      console.error('❌ Error inserting payment record:', paymentError)
      throw paymentError
    }

    console.log('✅ Payment record created successfully')
  }

  // Update campaign or requirement metadata
  if (campaign_id) {
    await updateCampaignPaymentMetadata(supabase, campaign_id, {
      id: paymentIntent.id,
      amount_total: paymentIntent.amount,
      payment_status: 'paid',
      metadata: paymentIntent.metadata
    })
  }

  if (task_id) {
    await updateRequirementPaymentMetadata(supabase, task_id, {
      id: paymentIntent.id,
      amount_total: paymentIntent.amount,
      payment_status: 'paid',
      metadata: paymentIntent.metadata
    })
  }
}

async function updateCampaignPaymentMetadata(supabase: any, campaignId: string, paymentData: any) {
  // Get current campaign metadata
  const { data: campaign, error: fetchError } = await supabase
    .from('campaigns')
    .select('metadata')
    .eq('id', campaignId)
    .single()

  if (fetchError) {
    console.error('❌ Error fetching campaign:', fetchError)
    return
  }

  // Update metadata with payment information
  const updatedMetadata = {
    ...campaign.metadata,
    payment_status: {
      status: 'paid',
      amount_paid: paymentData.amount_total / 100,
      currency: paymentData.currency || 'USD',
      payment_method: 'stripe',
      stripe_payment_intent_id: paymentData.id,
      payment_date: new Date().toISOString(),
      outsourced: true,
      outsource_provider: 'uncodie',
      session_metadata: paymentData.metadata
    }
  }

  const { error: updateError } = await supabase
    .from('campaigns')
    .update({ 
      metadata: updatedMetadata,
      updated_at: new Date().toISOString()
    })
    .eq('id', campaignId)

  if (updateError) {
    console.error('❌ Error updating campaign metadata:', updateError)
    throw updateError
  }

  console.log('✅ Campaign payment metadata updated successfully')
}

async function updateRequirementPaymentMetadata(supabase: any, taskId: string, paymentData: any) {
  // Get current requirement metadata
  const { data: requirement, error: fetchError } = await supabase
    .from('requirements')
    .select('metadata')
    .eq('id', taskId)
    .single()

  if (fetchError) {
    console.error('❌ Error fetching requirement:', fetchError)
    return
  }

  // Update metadata with payment information
  const updatedMetadata = {
    ...requirement.metadata,
    payment_status: {
      status: 'paid',
      amount_paid: paymentData.amount_total / 100,
      currency: paymentData.currency || 'USD',
      payment_method: 'stripe',
      stripe_payment_intent_id: paymentData.id,
      payment_date: new Date().toISOString(),
      outsourced: true,
      outsource_provider: 'uncodie',
      session_metadata: paymentData.metadata
    }
  }

  const { error: updateError } = await supabase
    .from('requirements')
    .update({ 
      metadata: updatedMetadata,
      updated_at: new Date().toISOString()
    })
    .eq('id', taskId)

  if (updateError) {
    console.error('❌ Error updating requirement metadata:', updateError)
    throw updateError
  }

  console.log('✅ Requirement payment metadata updated successfully')
} 