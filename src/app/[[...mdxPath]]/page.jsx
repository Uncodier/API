import { generateStaticParamsFor, importPage } from 'nextra/pages'
import { useMDXComponents as getMDXComponents } from '../../../mdx-components'
import { notFound } from 'next/navigation'

export const generateStaticParams = generateStaticParamsFor('mdxPath')
export const dynamicParams = false

let staticParamsCache = null;
async function isPageValid(mdxPath) {
  if (!staticParamsCache || process.env.NODE_ENV === 'development') {
    staticParamsCache = await generateStaticParams()
  }
  const pathStr = (mdxPath || []).join('/')
  return staticParamsCache.some(p => (p.mdxPath || []).join('/') === pathStr)
}

export async function generateMetadata(props) {
  const paramsObj = await props.params
  // Normalize mdxPath: undefined means root route, should map to index.mdx
  const mdxPath = paramsObj.mdxPath === undefined 
    ? [] 
    : (paramsObj.mdxPath && paramsObj.mdxPath.length > 0 ? paramsObj.mdxPath : [])
  
  if (!(await isPageValid(mdxPath))) {
    return {}
  }

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
  
  if (!(await isPageValid(mdxPath))) {
    notFound()
  }

  let result;
  try {
    result = await importPage(mdxPath)
  } catch (error) {
    // If import fails (e.g., for non-MDX routes like favicon.ico), return 404
    notFound()
  }

  const { default: MDXContent, toc, metadata } = result;
  return (
    <Wrapper toc={toc} metadata={metadata}>
      <MDXContent {...props} params={paramsObj} />
    </Wrapper>
  )
} 