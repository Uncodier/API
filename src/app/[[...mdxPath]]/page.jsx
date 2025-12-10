import { generateStaticParamsFor, importPage } from 'nextra/pages'
import { useMDXComponents as getMDXComponents } from '../../../mdx-components'
import { notFound } from 'next/navigation'

export const generateStaticParams = generateStaticParamsFor('mdxPath')

export async function generateMetadata(props) {
  const paramsObj = await props.params
  // Normalize mdxPath: undefined means root route, should map to index.mdx
  // For root route (/), mdxPath is undefined, which should become [] for Nextra
  const mdxPath = paramsObj.mdxPath === undefined 
    ? [] 
    : (paramsObj.mdxPath && paramsObj.mdxPath.length > 0 ? paramsObj.mdxPath : [])
  
  try {
    const { metadata } = await importPage(mdxPath)
    return metadata
  } catch (error) {
    // If import fails, return empty metadata
    return {}
  }
}

const Wrapper = getMDXComponents().wrapper

export default async function Page(props) {
  const paramsObj = await props.params
  // Normalize mdxPath: undefined means root route (/), should map to index.mdx
  // Empty array [] maps to index.mdx in Nextra
  const mdxPath = paramsObj.mdxPath === undefined 
    ? [] 
    : (paramsObj.mdxPath && paramsObj.mdxPath.length > 0 ? paramsObj.mdxPath : [])
  
  try {
    const result = await importPage(mdxPath)
    const { default: MDXContent, toc, metadata } = result
    return (
      <Wrapper toc={toc} metadata={metadata}>
        <MDXContent {...props} params={paramsObj} />
      </Wrapper>
    )
  } catch (error) {
    // If import fails (e.g., for non-MDX routes like favicon.ico), return 404
    notFound()
  }
} 