import Stripe from 'stripe';

// Inicializar Stripe con la clave secreta
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-05-28.basil',
});

// POST - Crear Payment Intent
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { 
      amount, 
      currency = 'usd',
      customer_id,
      payment_method_id,
      card_details, // Para pagos con tarjeta nueva
      site_id,
      task_id,
      campaign_id,
      description = 'Outsource project payment'
    } = body;

    console.log('Payment request received:', {
      amount,
      currency,
      has_customer_id: !!customer_id,
      has_payment_method_id: !!payment_method_id,
      has_card_details: !!card_details,
      site_id,
      task_id,
      campaign_id
    });

    // Validaciones
    if (!amount || amount <= 0) {
      return new Response(JSON.stringify({
        error: 'Amount is required and must be greater than 0'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!site_id) {
      return new Response(JSON.stringify({
        error: 'Site ID is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Convertir amount a centavos (Stripe usa centavos)
    const amountInCents = Math.round(amount * 100);

    let finalPaymentMethodId = payment_method_id;
    let finalCustomerId = customer_id;

    // Si no hay payment_method_id pero sí card_details, crear payment method
    if (!payment_method_id && card_details) {
      console.log('Creating new payment method from card details');
      
      try {
        const paymentMethod = await stripe.paymentMethods.create({
          type: 'card',
          card: {
            number: card_details.number.replace(/\s/g, ''), // Remover espacios
            exp_month: card_details.exp_month,
            exp_year: card_details.exp_year,
            cvc: card_details.cvc,
          },
          billing_details: card_details.billing_details || {}
        });

        finalPaymentMethodId = paymentMethod.id;
        console.log('Payment method created:', paymentMethod.id);

        // Si no hay customer pero tenemos billing details, crear customer
        if (!customer_id && card_details.billing_details?.email) {
          const customer = await stripe.customers.create({
            email: card_details.billing_details.email,
            name: card_details.billing_details.name,
            payment_method: paymentMethod.id,
            metadata: {
              site_id: site_id
            }
          });

          finalCustomerId = customer.id;
          console.log('Customer created:', customer.id);
        }

      } catch (error: any) {
        console.error('Error creating payment method:', error);
        return new Response(JSON.stringify({
          error: `Invalid card details: ${error.message}`,
          type: 'card_error'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Crear Payment Intent
    const paymentIntentData: Stripe.PaymentIntentCreateParams = {
      amount: amountInCents,
      currency: currency.toLowerCase(),
      description,
      metadata: {
        site_id,
        task_id: task_id || '',
        campaign_id: campaign_id || '',
        created_from: 'outsource_checkout'
      }
    };

    // Si hay customer_id, agregarlo
    if (finalCustomerId) {
      paymentIntentData.customer = finalCustomerId;
    }

    // Si hay payment_method_id, configurar para confirmación inmediata
    if (finalPaymentMethodId) {
      paymentIntentData.payment_method = finalPaymentMethodId;
      paymentIntentData.confirmation_method = 'manual';
      paymentIntentData.confirm = true;
      paymentIntentData.return_url = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/outsource/confirmation`;
      
      // Si es un customer existente, attach el payment method
      if (finalCustomerId && finalPaymentMethodId && !payment_method_id) {
        try {
          await stripe.paymentMethods.attach(finalPaymentMethodId, {
            customer: finalCustomerId,
          });
          console.log('Payment method attached to customer');
        } catch (attachError) {
          console.warn('Could not attach payment method to customer:', attachError);
        }
      }
    } else {
      paymentIntentData.confirmation_method = 'automatic';
    }

    console.log('Creating payment intent with data:', {
      amount: paymentIntentData.amount,
      currency: paymentIntentData.currency,
      customer: paymentIntentData.customer,
      payment_method: paymentIntentData.payment_method,
      confirmation_method: paymentIntentData.confirmation_method
    });

    const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);

    console.log('Payment intent created:', {
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount
    });

    // Respuesta según el estado
    if (paymentIntent.status === 'requires_action') {
      console.log('Payment requires action (3D Secure)');
      return new Response(JSON.stringify({
        requires_action: true,
        payment_intent: {
          id: paymentIntent.id,
          client_secret: paymentIntent.client_secret,
          status: paymentIntent.status
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else if (paymentIntent.status === 'succeeded') {
      console.log('Payment succeeded immediately');
      return new Response(JSON.stringify({
        success: true,
        payment_intent: {
          id: paymentIntent.id,
          status: paymentIntent.status,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          customer_id: finalCustomerId,
          payment_method_id: finalPaymentMethodId
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      console.log('Payment in pending state:', paymentIntent.status);
      return new Response(JSON.stringify({
        success: false,
        payment_intent: {
          id: paymentIntent.id,
          client_secret: paymentIntent.client_secret,
          status: paymentIntent.status
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

  } catch (error: any) {
    console.error('Stripe Payment Intent Error:', error);
    
    // Manejar diferentes tipos de errores de Stripe
    let errorMessage = 'Internal server error';
    let errorType = 'api_error';
    let statusCode = 500;

    if (error.type) {
      errorType = error.type;
      errorMessage = error.message;

      switch (error.type) {
        case 'card_error':
          statusCode = 400;
          errorMessage = error.message || 'Your card was declined.';
          break;
        case 'rate_limit_error':
          statusCode = 429;
          errorMessage = 'Too many requests. Please try again later.';
          break;
        case 'invalid_request_error':
          statusCode = 400;
          errorMessage = error.message || 'Invalid request parameters.';
          break;
        case 'authentication_error':
          statusCode = 401;
          errorMessage = 'Authentication with Stripe failed.';
          break;
        case 'api_connection_error':
          statusCode = 502;
          errorMessage = 'Network communication with Stripe failed.';
          break;
        case 'api_error':
          statusCode = 500;
          errorMessage = 'An error occurred with Stripe API.';
          break;
      }
    }
    
    return new Response(JSON.stringify({
      error: errorMessage,
      type: errorType,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    }), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// GET - Consultar Payment Intent
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const paymentIntentId = url.searchParams.get('payment_intent_id');

    if (!paymentIntentId) {
      return new Response(JSON.stringify({
        error: 'Payment Intent ID is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('Retrieving payment intent:', paymentIntentId);

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['charges']
    });

    // Cast para incluir charges expandidos
    const expandedPaymentIntent = paymentIntent as unknown as Stripe.PaymentIntent & {
      charges: Stripe.ApiList<Stripe.Charge>;
    };

    return new Response(JSON.stringify({
      payment_intent: {
        id: expandedPaymentIntent.id,
        status: expandedPaymentIntent.status,
        amount: expandedPaymentIntent.amount,
        currency: expandedPaymentIntent.currency,
        metadata: expandedPaymentIntent.metadata,
        created: expandedPaymentIntent.created,
        charges: expandedPaymentIntent.charges?.data?.map((charge: Stripe.Charge) => ({
          id: charge.id,
          status: charge.status,
          paid: charge.paid,
          failure_message: charge.failure_message
        }))
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Stripe Retrieve Payment Intent Error:', error);
    
    return new Response(JSON.stringify({
      error: error.message || 'Internal server error',
      type: error.type || 'api_error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// PUT - Confirmar Payment Intent (para casos específicos)
export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const { payment_intent_id, payment_method_id } = body;

    if (!payment_intent_id) {
      return new Response(JSON.stringify({
        error: 'Payment Intent ID is required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const confirmData: any = {};
    
    if (payment_method_id) {
      confirmData.payment_method = payment_method_id;
    }

    const paymentIntent = await stripe.paymentIntents.confirm(
      payment_intent_id,
      confirmData
    );

    return new Response(JSON.stringify({
      payment_intent: {
        id: paymentIntent.id,
        status: paymentIntent.status,
        client_secret: paymentIntent.client_secret
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Stripe Confirm Payment Intent Error:', error);
    
    return new Response(JSON.stringify({
      error: error.message || 'Internal server error',
      type: error.type || 'api_error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

