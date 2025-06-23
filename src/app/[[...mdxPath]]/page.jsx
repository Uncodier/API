import { generateStaticParamsFor, importPage } from 'nextra/pages'
import { useMDXComponents as getMDXComponents } from '../../../mdx-components'

export const generateStaticParams = generateStaticParamsFor('mdxPath')

export async function generateMetadata(props) {
  try {
    const paramsObj = await props.params
    if (!paramsObj?.mdxPath) {
      return {
        title: 'Uncodie API Documentation',
        description: 'API documentation for Uncodie'
      }
    }
    
    const { metadata } = await importPage(paramsObj.mdxPath)
    return metadata || {
      title: 'Uncodie API Documentation',
      description: 'API documentation for Uncodie'
    }
  } catch (error) {
    console.error('Error generating metadata:', error)
    return {
      title: 'Uncodie API Documentation',
      description: 'API documentation for Uncodie'
    }
  }
}

const Wrapper = getMDXComponents().wrapper

export default async function Page(props) {
  try {
    const paramsObj = await props.params
    
    if (!paramsObj?.mdxPath) {
      // Redireccionar a la página principal si no hay ruta
      const { default: IndexPage } = await importPage(['index'])
      return <IndexPage {...props} params={paramsObj} />
    }
    
    const result = await importPage(paramsObj.mdxPath)
    const { default: MDXContent, toc, metadata } = result
    
    return (
      <Wrapper toc={toc} metadata={metadata}>
        <MDXContent {...props} params={paramsObj} />
      </Wrapper>
    )
  } catch (error) {
    console.error('Error rendering page:', error)
    
    // Página de error simple
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <h1>Page Not Found</h1>
        <p>The page you're looking for doesn't exist.</p>
        <a href="/">Go back to home</a>
      </div>
    )
  }
} 